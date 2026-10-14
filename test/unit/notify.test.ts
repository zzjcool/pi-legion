import { test } from "node:test";
import assert from "node:assert/strict";
import {
	completionDeliveryOptions,
	completionStatusOf,
	deliverCompletion,
	formatCollectFailure,
	formatCompletionNotice,
	formatGroupedNotice,
	type GroupedEntry,
	formatNoticeHeadline,
	previewOutput,
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
	assert.match(notice.content, /RPC child retired/);
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
	assert.doesNotMatch(notice.content, /RPC child retired/);
});

test("formatCollectFailure does not present a bare Connection error as the failure reason", () => {
	const notice = formatCollectFailure("worker-0", new Error("Connection error."));
	assert.equal(notice.status, "failed");
	assert.match(notice.content, /Connection error\. \(RPC child is not alive\)/);
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
	assert.match(notice.content, /\(RPC child retired\)/);
});

test("formatGroupedNotice: retirement markers are per-entry, not a blanket footer", () => {
	// A wait()-released sibling can race the flush window: a blanket retirement
	// footer would be inaccurate while another RPC child is still alive.
	const notice = formatGroupedNotice({
		entries: [
			groupedEntry({ name: "kept", recycled: false }),
			groupedEntry({ name: "gone" }),
		],
	});
	assert.match(notice.content, /- gone \(worker\): completed .*\(RPC child retired\)/);
	assert.doesNotMatch(notice.content, /- kept \(worker\): completed .*RPC child retired/);
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
