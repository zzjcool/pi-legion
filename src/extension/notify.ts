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

import { isTransientConnectionFailure } from "../shared/session.ts";

export const SUBAGENT_NOTIFY_TYPE = "subagent-notify";

export type CompletionStatus = "completed" | "failed" | "stopped" | "running";

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
	const content = [
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
			: "RPC child retired. Resume from the session file if you need this child again.",
	]
		.filter((line) => line !== undefined)
		.join("\n");
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
		? `${raw} (RPC child is not alive)`
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
 * blanket footer could be inaccurate): entries whose RPC child is retired
 * carry an inline "(RPC child retired)" marker.
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
		// be released while another RPC child is still alive, so no blanket footer.
		const recycled = entry.recycled === false ? "" : " (RPC child retired)";
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
