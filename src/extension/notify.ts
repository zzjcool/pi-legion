/**
 * Parent-session completion delivery.
 *
 * pi-subagents does NOT let a child prompt the parent. The extension watches
 * the child, then injects a custom message into the parent session with
 * `triggerTurn` so the parent wakes up and reads the result.
 *
 * Every notice is `display: true` so the transcript records the completion.
 * pi-subagents kept success quiet (`display: false`) to avoid a 4 KB purple
 * block per child; we render instead of hiding: `notice-renderer.ts` collapses
 * a completed notice to one line (`ctrl+o` expands it), and failures fall
 * through to Pi's default Markdown block. The payload the LLM sees is the same
 * either way — `display` only steers the TUI.
 *
 * Delivery is `followUp`, not the default `steer`. Steer would hijack the
 * parent's next LLM call while it is still in a tool loop. Follow-up waits
 * until that turn is idle; if the parent is already idle, `triggerTurn`
 * still starts a new turn immediately.
 */

import {
	PROGRESS_MIN_FILES_CHANGED,
	PROGRESS_MIN_TOOL_RESULTS,
} from "../runs/progress-signal.ts";
import { isTransientConnectionFailure } from "../shared/session.ts";

export const SUBAGENT_NOTIFY_TYPE = "subagent-notify";

export type CompletionStatus = "completed" | "failed" | "stopped" | "running";

/**
 * D2/D2-a progress measurement, as carried by a renewal proposal.
 *
 * Exactly W1's `ProgressMeasure` minus `progressed` (D2-a): the renderer
 * re-derives the verdict from `PROGRESS_MIN_TOOL_RESULTS` /
 * `PROGRESS_MIN_FILES_CHANGED`, so a notice can never claim progress the
 * measurer would not, and the thresholds have one home. No extra fields, so
 * a caller can pass a `ProgressMeasure` straight through.
 */
export interface RenewalProgress {
	/** New `toolResult` rows since the renewal baseline (a tool returned). */
	readonly toolResults: number;
	/** New assistant messages since the baseline (shown, never decides — D2-a). */
	readonly assistantMessages: number;
	/** Files created/modified in the worktree; absent when not measurable. */
	readonly filesChanged?: number;
}

/**
 * D3: structured renewal proposal (subagent-renewal contract v1, W3).
 *
 * **Terminal paths only (D7).** A renewal proposal requires that the child is
 * actually dead and its session file survived — so ONLY the path that observes
 * a terminated child may populate it. `wait { timeoutMs }` and
 * `collect { timeoutMs }` timeouts mean the parent gave up waiting while the
 * child is still alive (`inprocess-supervisor` just resolves
 * `{settled:false, reason:"timeout"}`): those call sites must leave `renewal`
 * undefined, and then this field's absence keeps every renewal line out of the
 * notice. Renewing a live child would spend a fresh turn budget on a child
 * that never lost one. Locked by test "A3/D7".
 */
export interface RenewalProposal {
	/** D2 measurement at the moment of termination. */
	readonly progress: RenewalProgress;
	/** D6: how many renewals already used. */
	readonly used: number;
	readonly max: number;
	/** The exact command that renews this child (D4: always `continue`). */
	readonly command: string;
}

export interface CompletionInput {
	name: string;
	agent?: string;
	execution: { status: string; reason?: string };
	output: string;
	/** Full output on disk; the truncated preview names this path. */
	outputFile?: string;
	sessionFile?: string;
	acceptance?: { status: string; level?: string };
	recycled?: boolean;
	/**
	 * D3: structured renewal proposal, present only when the renewal contract
	 * fires. Only a **real termination** populates it — `wait`/`collect`
	 * timeouts describe a still-alive child and must pass nothing here (D7);
	 * see `RenewalProposal` for the full premise.
	 */
	renewal?: RenewalProposal | undefined;
}

export interface CompletionNotice {
	content: string;
	display: boolean;
	status: CompletionStatus;
	/** TUI-only metadata; persisted with the entry, never sent to the LLM. */
	details: CompletionDetails;
}

/**
 * Structured copy of a notice for the TUI renderer.
 *
 * Kept free of the (up to 4 KB) output preview so the collapsed line can be
 * laid out without parsing `content` back apart.
 */
export interface CompletionDetails {
	status: CompletionStatus;
	name: string;
	agent?: string;
	execution: { status: string; reason?: string };
	acceptance?: { status: string; level?: string };
	sessionFile?: string;
	outputBytes: number;
	recycled?: boolean;
}

/** `1234` -> `1.2 KB`, so the collapsed line says how much landed. */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Strip what would break a one-row TUI line: control characters (newline,
 * ESC included) and any escape sequence they could have introduced.
 *
 * Child names are usually sanitized in `src/shared/name.ts`, but `agent`
 * labels come from frontmatter the extension does not control. Everything
 * the headline interpolates passes through here.
 */
export function sanitizeNoticeField(value: string): string {
	return value.replace(/[\x00-\x1f\x7f]/g, "");
}

/** `✓ worker-0 (worker) · success · acceptance accepted (verified) · 1.2 KB`. */
export function formatNoticeHeadline(details: CompletionDetails): string {
	const glyph =
		details.status === "completed"
			? "✓"
			: details.status === "stopped"
				? "■"
				: "✗";
	const label = sanitizeNoticeField(
		details.agent
			? `${details.name} (${details.agent})`
			: details.name,
	);
	const reason = details.execution.reason
		? sanitizeNoticeField(details.execution.reason)
		: "";
	const bits = [
		`${sanitizeNoticeField(details.execution.status)}${reason ? ` (${reason})` : ""}`,
	];
	if (details.acceptance) {
		const level = details.acceptance.level
			? ` (${sanitizeNoticeField(details.acceptance.level)})`
			: "";
		bits.push(
			`acceptance ${sanitizeNoticeField(details.acceptance.status)}${level}`,
		);
	}
	bits.push(formatSize(details.outputBytes));
	return `${glyph} ${label} · ${bits.join(" · ")}`;
}

const PREVIEW_CHARS = 4_000;

/**
 * Map an execution status onto the coarse notification label.
 *
 * `unknown` needs a witness for compatibility with legacy records that did
 * not persist a structured stopReason. When a verdict was parsed (acceptance
 * accepted/rejected), the turn demonstrably ran and finished — report
 * completion and let the `acceptance:` line carry the verdict. Without that
 * witness, `unknown` stays `failed` (no usable session messages).
 *
 * `running` is NOT a completion and is reported as itself (B). It used to fall
 * through to the `failed` default, so a collect timeout on a live child sent
 * "Background task failed" while the body said "still alive". A running
 * snapshot must never be formatted at all — `formatCompletionNotice` (and
 * `JoinCoordinator.onTerminal`) throw on it instead.
 */
export function completionStatusOf(
	executionStatus: string,
	acceptanceStatus?: string,
): CompletionStatus {
	if (executionStatus === "running") return "running";
	if (executionStatus === "success") return "completed";
	if (executionStatus === "aborted") return "stopped";
	if (
		executionStatus === "unknown" &&
		(acceptanceStatus === "accepted" || acceptanceStatus === "rejected")
	) {
		return "completed";
	}
	return "failed";
}

export function previewOutput(
	text: string,
	max = PREVIEW_CHARS,
	hints?: { sessionFile?: string; name?: string },
): string {
	const trimmed = text.trim() || "(no output)";
	if (trimmed.length <= max) return trimmed;
	// The preview is a hook, not the payload: name the recovery move so the
	// parent model does not re-derive it (or, worse, re-launch a search that
	// already finished — a duplicate child for a result already on disk).
	const who = hints?.name ? ` ${hints.name}` : "";
	const where = hints?.sessionFile
		? ` — full text: ${hints.sessionFile}`
		: ` — collect${who} for the full text`;
	return `${trimmed.slice(0, max)}\n…(preview truncated${where})`;
}

/**
 * D2-a verdict for a rendered proposal, recomputed from W1's exported
 * thresholds so the notice and the measurer cannot disagree: 3 new tool
 * results, or 1 changed file. Assistant messages are displayed but never
 * decide — a model repeating itself grows that count forever, and that is
 * exactly the case where a renewal must not be offered.
 */
function countsAsProgress(progress: RenewalProgress): boolean {
	if (progress.toolResults >= PROGRESS_MIN_TOOL_RESULTS) return true;
	return (
		progress.filesChanged !== undefined &&
		progress.filesChanged >= PROGRESS_MIN_FILES_CHANGED
	);
}

/**
 * D3: the trailing renewal block, as notice lines.
 *
 * Three shapes (the measurement line always leads — D3 asks for the judgement
 * basis *and* the command, and "this child produced 47 tool results before it
 * died" is the whole argument):
 *
 *   progressed: 47 tool results, 12 assistant messages, 6 files changed
 *   renew: subagent({ action: "continue", name: "W2", message: "<what to continue>" })
 *   renewals: 1/2
 *
 *   … no measurable progress since spawn — not offering a renewal      (A2)
 *   … renewals exhausted (2/2) — split the task instead of renewing    (D6/A5)
 *
 * `used/max` is "renewals consumed so far", matching the exhausted line.
 * An unmeasurable `filesChanged` drops out instead of printing `undefined`.
 */
export function formatRenewalBlock(renewal: RenewalProposal): string[] {
	const bits = [
		`${renewal.progress.toolResults} tool results`,
		`${renewal.progress.assistantMessages} assistant messages`,
	];
	if (renewal.progress.filesChanged !== undefined) {
		bits.push(`${renewal.progress.filesChanged} files changed`);
	}
	const lines = [`progressed: ${bits.join(", ")}`];
	// A2/D2: renewing a child that moved no output forward just extends the
	// hang by one full turn budget — the exact reason the role timeout exists.
	if (!countsAsProgress(renewal.progress)) {
		lines.push("no measurable progress since spawn — not offering a renewal");
		return lines;
	}
	// D6/A5: the budget is a hard ceiling; past it the split is wrong, not the
	// budget. Say so instead of offering a fourth attempt.
	if (renewal.used >= renewal.max) {
		lines.push(
			`renewals exhausted (${renewal.used}/${renewal.max}) — split the task instead of renewing`,
		);
		return lines;
	}
	// D4/A8: renewal *is* `continue`; the caller hands us the finished command
	// so the parent needs one line of typing, not a re-derivation.
	lines.push(`renew: ${sanitizeNoticeField(renewal.command)}`);
	lines.push(`renewals: ${renewal.used}/${renewal.max}`);
	return lines;
}

/**
 * The renewal block for a notice, or `undefined` when there is nothing to say.
 *
 * A completed child is never a renewal candidate (D1 condition 1): if the turn
 * produced a verdict it is not a budget casualty, and offering `continue`
 * would relaunch finished work.
 */
function renewalLinesFor(
	status: CompletionStatus,
	renewal: RenewalProposal | undefined,
): string[] | undefined {
	if (!renewal || status === "completed") return undefined;
	return formatRenewalBlock(renewal);
}

export function formatCompletionNotice(input: CompletionInput): CompletionNotice {
	const status = completionStatusOf(
		input.execution.status,
		input.acceptance?.status,
	);
	if (status === "running") {
		// Fail loud (B): a still-alive child is a progress signal, not a verdict.
		// watch() re-arms on a running snapshot instead of notifying, so reaching
		// here means a caller lost that guard — never silently label it.
		throw new Error("running snapshot is not a completion");
	}
	const label = input.agent ? `${input.name} (${input.agent})` : input.name;
	const reason = input.execution.reason
		? ` (${input.execution.reason})`
		: "";
	const acceptance = input.acceptance
		? `acceptance: ${input.acceptance.status}${input.acceptance.level ? ` (${input.acceptance.level})` : ""}`
		: undefined;
	const previewHints: { name?: string; sessionFile?: string } = {};
	if (input.name) previewHints.name = input.name;
	// Prefer the durable full-text artifact over the session file as the
	// recovery pointer: one `read` beats re-deriving from jsonl/chat store.
	if (input.outputFile) previewHints.sessionFile = input.outputFile;
	else if (input.sessionFile) previewHints.sessionFile = input.sessionFile;
	const preview = previewOutput(input.output, PREVIEW_CHARS, previewHints);
	const lines: Array<string | undefined> = [
		`Background task ${status}: **${label}**`,
		"",
		`execution: ${input.execution.status}${reason}`,
		acceptance,
		"",
		preview,
		input.outputFile ? `Full output: ${input.outputFile}` : undefined,
		input.sessionFile ? "" : undefined,
		input.sessionFile ? `Session file: ${input.sessionFile}` : undefined,
		input.recycled === false
			? undefined
			: "Child retired. Resume from the session file if you need this child again.",
	];
	// D3: the renewal proposal trails the failure body — appended, never woven
	// in, so an unrenewable notice is byte-identical to what it was before.
	const renewalLines = renewalLinesFor(status, input.renewal);
	if (renewalLines) lines.push("", ...renewalLines);
	const content = lines.filter((line) => line !== undefined).join("\n");
	return {
		content,
		display: true,
		status,
		details: {
			status,
			name: input.name,
			agent: input.agent,
			execution: {
				status: input.execution.status,
				reason: input.execution.reason,
			},
			acceptance: input.acceptance
				? {
						status: input.acceptance.status,
						level: input.acceptance.level,
					}
				: undefined,
			sessionFile: input.sessionFile,
			outputBytes: Buffer.byteLength(preview),
			recycled: input.recycled,
		},
	};
}

export function collectFailureInput(
	name: string,
	error: unknown,
): CompletionInput {
	const raw = error instanceof Error ? error.message : String(error);
	// Live children never reach here: watch() re-arms a connection blip.
	// A dead child's notice names that, instead of a bare "Connection error."
	const reason = isTransientConnectionFailure(raw)
		? `${raw} (child is not alive)`
		: raw;
	return {
		name,
		execution: { status: "failed", reason },
		output: raw,
		recycled: false,
	};
}

export function formatCollectFailure(name: string, error: unknown): CompletionNotice {
	return formatCompletionNotice(collectFailureInput(name, error));
}

// ---------------------------------------------------------------------------
// Grouped (smart-join) delivery
// ---------------------------------------------------------------------------

export interface GroupedEntry extends CompletionInput {
	status: CompletionStatus;
}

export interface GroupedCompletionInput {
	/** Omitted run header when absent. */
	runId?: string;
	entries: GroupedEntry[];
	/** Members still running at flush time (partial flush). */
	stillRunning?: string[];
}

/**
 * Merge several terminal children into ONE notice so a fan-out wakes the
 * parent once, not once per child:
 *
 *   Background tasks completed (2 of 3):
 *   - worker-0 (worker): completed — acceptance: accepted (attested)
 *     <previewOutput, per-entry cap max(500, PREVIEW_CHARS/entries.length)>
 *   - reviewer-1: failed (model error)
 *   Still running: slow-2 (notifies separately when it finishes)
 *
 * Retirement is per-entry (a wait()-released sibling can race the flush, so a
 * blanket footer could be inaccurate): entries whose child is retired
 * carry an inline "(child retired)" marker.
 * Aggregate status: any failed → "failed"; else any stopped → "stopped";
 * else "completed". `display` follows the single-notice rule.
 */
export function formatGroupedNotice(
	input: GroupedCompletionInput,
): CompletionNotice {
	const entries = input.entries;
	const stillRunning = input.stillRunning ?? [];
	const perEntryMax = Math.max(
		500,
		Math.floor(PREVIEW_CHARS / Math.max(1, entries.length)),
	);
	const header =
		stillRunning.length > 0
			? `Background tasks completed (${entries.length} of ${entries.length + stillRunning.length}):`
			: `Background tasks completed (${entries.length}):`;
	const lines: string[] = [];
	if (input.runId) lines.push(`Run: ${input.runId}`);
	lines.push(header);
	let anyFailed = false;
	let anyStopped = false;
	for (const entry of entries) {
		if (entry.status === "failed") anyFailed = true;
		if (entry.status === "stopped") anyStopped = true;
		const label = entry.agent
			? `${entry.name} (${entry.agent})`
			: entry.name;
		const reason = entry.execution.reason
			? ` (${entry.execution.reason})`
			: "";
		const acceptance = entry.acceptance
			? ` — acceptance: ${entry.acceptance.status}${entry.acceptance.level ? ` (${entry.acceptance.level})` : ""}`
			: "";
		// Retirement is per-entry truth: a wait()-consumed sibling may already
		// be released while another child is still alive, so no blanket footer.
		const recycled = entry.recycled === false ? "" : " (child retired)";
		lines.push(`- ${label}: ${entry.status}${reason}${acceptance}${recycled}`);
		// Prefer the durable full-text artifact over the session file as the
		// recovery pointer: one `read` beats re-deriving from jsonl/chat store.
		const fullText = entry.outputFile ?? entry.sessionFile;
		const previewHints: { name?: string; sessionFile?: string } = {};
		if (entry.name) previewHints.name = entry.name;
		if (fullText) previewHints.sessionFile = fullText;
		lines.push(
			`  ${previewOutput(entry.output, perEntryMax, previewHints)}`,
		);
		if (entry.outputFile)
			lines.push(`  Full output: ${entry.outputFile}`);
	}
	if (stillRunning.length > 0) {
		lines.push(
			`Still running: ${stillRunning.join(", ")} (notifies separately when it finishes)`,
		);
	}
	const status: CompletionStatus = anyFailed
		? "failed"
		: anyStopped
			? "stopped"
			: "completed";
	const preview = lines.join("\n");
	return {
		content: preview,
		// display:true matches the single-child path (master f966088): the
		// renderer collapses a completed batch to one row instead of hiding it.
		display: true,
		status,
		details: {
			status,
			// The collapsed row names every member, so a batch stays scannable:
			// `✓ worker-0, worker-1 · 2 of 2 · 4.5 KB`.
			name: entries.map((entry) => entry.name).join(", "),
			execution: { status: `batch ${entries.length}` },
			sessionFile: input.runId,
			outputBytes: Buffer.byteLength(preview),
		},
	};
}

export interface SendMessageOptions {
	triggerTurn?: boolean;
	deliverAs?: "steer" | "followUp" | "nextTurn";
}

export interface SendMessageApi {
	sendMessage(
		message: {
			customType: string;
			content: string;
			display: boolean;
			details?: unknown;
		},
		options?: SendMessageOptions,
	): void;
}

/**
 * How a completion notice should enter the parent session.
 *
 * `triggerTurn: false` only records the message. `true` wakes the parent, but
 * via `followUp` so an in-flight parent turn is not steered mid-work.
 */
export function completionDeliveryOptions(
	triggerTurn: boolean,
): SendMessageOptions {
	if (!triggerTurn) return { triggerTurn: false };
	return { triggerTurn: true, deliverAs: "followUp" };
}

/**
 * Inject the notice into the parent session.
 *
 * Returns false when the runtime rejected the send (session gone, shutdown).
 * The child's session file is still on disk; the parent can `collect` later.
 */
export function deliverCompletion(
	pi: SendMessageApi,
	notice: CompletionNotice,
	triggerTurn = true,
): boolean {
	try {
		pi.sendMessage(
			{
				customType: SUBAGENT_NOTIFY_TYPE,
				content: notice.content,
				display: notice.display,
				details: notice.details,
			},
			completionDeliveryOptions(triggerTurn),
		);
		return true;
	} catch {
		return false;
	}
}
