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
	NOTICE_SOURCE_MARKER,
} from "../../src/extension/notify.ts";
// The tool the notice names as the one-step recovery (D7). Imported rather than spelled
// out in the assertions so a rename in `legion-output.ts` cannot leave `notify.ts`
// pointing at a tool that no longer exists.
import { LEGION_OUTPUT_TOOL_NAME } from "../../src/extension/legion-output.ts";

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
					reason: "collect deadline (per collect attempt) exceeded; child still alive",
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

test("formatCompletionNotice: a truncated preview names the reader, never the artifact path (P5d)", () => {
	// The whole point of the artifact: the notice must point the parent at a one-step
	// recovery (the tool), not a jsonl/chat-store re-derivation — and, since P5d, not at
	// a path either: the path is never an address the model is handed.
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
		/…\(preview truncated — full text: legion_output\(\{ name: "search-0" \}\)\)/,
	);
	assert.match(notice.content, /Full text: legion_output\(\{ name: "search-0" \}\)/);
	// The session file is the diagnostic pointer and stays; the artifact body is not.
	assert.ok(notice.content.includes("Session file: /runs/r-1/search-0.jsonl"));
	assert.doesNotMatch(notice.content, /runs\/r-1\/search-0\.output\.md/);
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

test("formatGroupedNotice: per-entry full-text lines name the reader (P5d)", () => {
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
		/…\(preview truncated — full text: legion_output\(\{ name: "search-0" \}\)\)/,
	);
	assert.match(notice.content, /Full text: legion_output\(\{ name: "search-0" \}\)/);
	assert.doesNotMatch(notice.content, /runs\/r-1\/search-0\.output\.md/, "P5d: no artifact path is printed");
	// Entries without an artifact must not grow a dangling pointer line.
	assert.doesNotMatch(notice.content, /Full text: undefined/);
	assert.doesNotMatch(notice.content, /Full text: legion_output\(\{ name: "worker-1" \}\)/);
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
	// D4: the footer states the fact only. The old "(notifies separately when it
	// finishes)" promised a second message for children whose watch could already
	// be gone, so it is deleted rather than reworded.
	assert.match(notice.content, /^Still running: slow-2$/m);
	assert.doesNotMatch(notice.content, /notifies separately/);
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
			reason: "collect deadline (per collect attempt) exceeded; child still alive",
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

test("regression: a notice without a renewal proposal keeps its body byte-identical (D5 adds one line)", () => {
	// Captured from notify.ts before the renewal block existed; the contract's
	// §6 "only add, never change" rule lives or dies on this assertion. D5 adds
	// exactly one line in front — everything after it is untouched.
	const failure = formatCompletionNotice({
		name: "worker-0",
		agent: "worker",
		execution: { status: "failed", reason: "terminated during tool call" },
		output: "boom",
		sessionFile: "/runs/r-1/worker-0.jsonl",
	});
	assert.equal(
		failure.content,
		`${NOTICE_SOURCE_MARKER}\n` +
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
		`${NOTICE_SOURCE_MARKER}\n` +
			"Background task completed: **reviewer-1**\n\nexecution: success\nacceptance: accepted (attested)\n\nall good\nFull text: legion_output({ name: \"reviewer-1\" })\nChild retired. Resume from the session file if you need this child again.",
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
		`${NOTICE_SOURCE_MARKER}\n` + "Background task stopped: **w1 (worker)**\n\nexecution: aborted (killed)\n\n(no output)",
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

test("formatCompletionNotice: a synthetic reason keeps the provider error visible", () => {
	const notice = formatCompletionNotice({
		name: "w1",
		agent: "worker",
		execution: {
			status: "failed",
			// `unknown stopReason` replaces the message in `reason`, so without the
			// dedicated line the 502 body would only exist in run.json.
			reason: "unknown stopReason: weird",
			stopReason: null,
			errorMessage: "502: bad gateway (cloudflare)",
		},
		output: "",
		acceptance: { status: "rejected", level: "none" },
		recycled: false,
	});
	assert.match(
		notice.content,
		/execution: failed \(unknown stopReason: weird\)\nerror: 502: bad gateway \(cloudflare\)/,
	);
	assert.equal(notice.details.execution.errorMessage, "502: bad gateway (cloudflare)");
	assert.equal(notice.details.execution.stopReason, null);

	// In the ordinary error shape the provider text IS the reason: no duplicate.
	const same = formatCompletionNotice({
		name: "w2",
		execution: { status: "failed", reason: "502: bad gateway", errorMessage: "502: bad gateway" },
		output: "",
		recycled: false,
	});
	assert.doesNotMatch(same.content, /\nerror: /);
	assert.equal(same.details.execution.errorMessage, "502: bad gateway");
});

// ─────────── delivery v2 §6.8/§6.9: the source marker, and details untouched ───────────

test("v2 §6.8: both notice paths start with the fixed source marker; the footer makes no promise", () => {
	// D5: the notice lands as a `role:user` message and starts a turn, so the model
	// needs a first-line marker to tell it from what the user typed (N3). Both
	// shapes carry the SAME line — a grouped notice is just as machine-generated.
	const single = formatCompletionNotice({
		name: "worker-0",
		agent: "worker",
		execution: { status: "success" },
		output: "done",
	});
	assert.equal(single.content.split("\n")[0], NOTICE_SOURCE_MARKER);
	assert.equal(NOTICE_SOURCE_MARKER, "▣ legion · automatic completion notice — not a user message");
	assert.match(single.content, /\nBackground task completed: \*\*worker-0 \(worker\)\*\*$/m);

	const grouped = formatGroupedNotice({
		runId: "r-1",
		entries: [groupedEntry({ name: "a" }), groupedEntry({ name: "b" })],
		stillRunning: ["slow-2"],
	});
	assert.equal(grouped.content.split("\n")[0], NOTICE_SOURCE_MARKER);
	// Exactly one marker line: the body is not decorated twice.
	assert.equal(grouped.content.split(NOTICE_SOURCE_MARKER).length, 2);
	// D4: the fact only — never the promise that a second notice will follow.
	assert.match(grouped.content, /^Still running: slow-2$/m);
	assert.doesNotMatch(grouped.content, /notifies separately/);
	assert.doesNotMatch(single.content, /notifies separately/);
});

test("v2 §6.9: the marker changes `content` only; `details` keeps its exact shape", () => {
	// The TUI collapses a completed notice to one row built from `details`, so the
	// marker must not leak into them — and `outputBytes` still measures the body,
	// not the marker line (a marker-sized drift would change every collapsed row).
	const single = formatCompletionNotice({
		name: "worker-0",
		agent: "worker",
		execution: { status: "success" },
		output: "done the thing",
		sessionFile: "/tmp/worker-0.jsonl",
		acceptance: { status: "attested", level: "attested" },
	});
	assert.deepEqual(single.details, {
		status: "completed",
		name: "worker-0",
		agent: "worker",
		execution: { status: "success", reason: undefined },
		acceptance: { status: "attested", level: "attested" },
		sessionFile: "/tmp/worker-0.jsonl",
		outputBytes: Buffer.byteLength("done the thing"),
		recycled: undefined,
	});
	assert.equal(single.display, true);
	assert.equal(
		JSON.stringify(single.details).includes(NOTICE_SOURCE_MARKER),
		false,
		"the marker belongs to content, not to the renderer's data",
	);

	const grouped = formatGroupedNotice({
		runId: "r-1",
		entries: [groupedEntry({ name: "a" }), groupedEntry({ name: "b" })],
	});
	assert.equal(grouped.details.status, "completed");
	assert.equal(grouped.details.name, "a, b");
	assert.deepEqual(grouped.details.execution, { status: "batch 2" });
	assert.equal(grouped.details.sessionFile, "r-1");
	assert.equal(
		grouped.details.outputBytes,
		Buffer.byteLength(grouped.content.slice(NOTICE_SOURCE_MARKER.length + 1)),
		"outputBytes counts the body after the marker, as before",
	);
	assert.equal(grouped.display, true);
});

// ───────── P5c (result-ledger-v1 §3 D9): the preview says what it is ─────────

test("P5c/D9: a truncated artifact-backed preview is labelled `preview X of Y` and names legion_output", () => {
	// The mislabel D9 exists for: the collapsed row printed `4.0 KB` for a 24.5 KB result,
	// because `outputBytes` measures the PREVIEW. With an artifact, the notice now prints
	// the pair and names the tool that can page the rest (D7).
	const readVia = `${LEGION_OUTPUT_TOOL_NAME}({ name: "search-0" })`;
	const notice = formatCompletionNotice({
		name: "search-0",
		agent: "search",
		execution: { status: "success" },
		output: "z".repeat(5_000),
		outputFile: "/runs/r-1/artifacts/search-0/r1.md",
		artifactId: "r-1/search-0/r1",
		sessionFile: "/runs/r-1/search-0.jsonl",
		acceptance: { status: "accepted", level: "attested" },
	});
	// (a) the truncation sentence no longer advises reading a file.
	assert.ok(
		notice.content.includes(`…(preview truncated — full text: ${readVia})`),
		"the preview hint names legion_output",
	);
	// (b) the honest pair, in the body — visible folded AND expanded, and for a failed
	// notice too (which the TUI renders as the plain block, not the collapsed row).
	assert.ok(notice.content.includes(`preview 3.9 KB of 4.9 KB · read via ${readVia}`));
	// (c) the reader is named — with the round the artifact id carries (D1) — and the
	// path is gone: P5d makes `legion_output` the only address a notice prints.
	assert.ok(
		notice.content.includes(`Full text: ${LEGION_OUTPUT_TOOL_NAME}({ name: "search-0", round: 1 })`),
	);
	assert.ok(
		!notice.content.includes("/runs/r-1/artifacts/search-0/r1.md"),
		"P5d: the artifact path never reaches the model",
	);
	// (d) the folded TUI row prints the same pair instead of the preview's size alone.
	const headline = formatNoticeHeadline(notice.details);
	assert.match(headline, /· preview 3\.9 KB of 4\.9 KB$/);
	// (e) the machine facts: the honest pair and the artifact locator.
	assert.deepEqual(notice.details.preview, { bytes: 4_000, ofBytes: 5_000 });
	assert.deepEqual(notice.details.artifactIds, ["r-1/search-0/r1"]);
	// `outputBytes` keeps its old meaning (the preview as delivered, truncation sentence
	// included) — the new field ADDS the split, it does not redefine the old number, so
	// every existing reader stays correct.
	assert.ok(notice.details.outputBytes > notice.details.preview!.bytes);
});

test("P5c/D9: a complete result carries no preview pair and no artifactIds key", () => {
	const notice = formatCompletionNotice({
		name: "worker-0",
		execution: { status: "success" },
		output: "done",
	});
	// Absent, not `{bytes: n, ofBytes: n}` and not `[]` — a complete result has nothing
	// to confess, and an empty array would read as "this notice has artifacts".
	assert.equal("preview" in notice.details, false);
	assert.equal("artifactIds" in notice.details, false);
	assert.doesNotMatch(notice.content, /legion_output/);
	assert.doesNotMatch(notice.content, /preview truncated/);
	// The folded row keeps its pre-P5c shape.
	assert.match(formatNoticeHeadline(notice.details), /· 4 B$/);
});

test("P5c/D9: a grouped notice reports its members' artifact ids, and each member's hint", () => {
	const withIds = formatGroupedNotice({
		runId: "r-1",
		entries: [
			groupedEntry({
				name: "a",
				output: "a".repeat(5_000),
				outputFile: "/runs/r-1/artifacts/a/r1.md",
				artifactId: "r-1/a/r1",
			}),
			groupedEntry({ name: "b", artifactId: "r-1/b/r1" }),
		],
	});
	assert.deepEqual(withIds.details.artifactIds, ["r-1/a/r1", "r-1/b/r1"]);
	// The batch entry's truncation hint names the tool too (same rule as the single
	// notice): the member has an artifact, so `legion_output` is the one-step read.
	assert.ok(
		withIds.content.includes(
			`…(preview truncated — full text: ${LEGION_OUTPUT_TOOL_NAME}({ name: "a" }))`,
		),
	);
	// …and the per-entry line names the reader with its round, never the path.
	assert.ok(
		withIds.content.includes(`  Full text: ${LEGION_OUTPUT_TOOL_NAME}({ name: "a", round: 1 })`),
	);
	assert.ok(!withIds.content.includes("/runs/r-1/artifacts/a/r1.md"), "P5d: no artifact path in a batch");

	const withoutIds = formatGroupedNotice({ entries: [groupedEntry({ name: "c" })] });
	assert.equal("artifactIds" in withoutIds.details, false, "never an empty array");

	// P5d: an `outputFile` with no ledger row is STILL an artifact body — the hint and
	// the line name the reader (only the round is missing, and `legion_output` resolves
	// the newest round itself). The path is not printed either way.
	const pathHint = formatGroupedNotice({
		entries: [
			groupedEntry({
				name: "d",
				output: "d".repeat(5_000),
				outputFile: "/runs/r-1/d.output.md",
			}),
		],
	});
	assert.ok(
		pathHint.content.includes(`…(preview truncated — full text: ${LEGION_OUTPUT_TOOL_NAME}({ name: "d" }))`),
	);
	assert.ok(pathHint.content.includes(`  Full text: ${LEGION_OUTPUT_TOOL_NAME}({ name: "d" })`));
	assert.doesNotMatch(pathHint.content, /\/runs\/r-1\/d\.output\.md/);
});
