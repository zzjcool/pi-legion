/**
 * Post-collect verification of writer acceptance criteria.
 *
 * L2 (`{"ok": true}`) is only attested — the agent is marking its own homework.
 * When a required criterion asks for `verification-output` **and carries an
 * explicit `command`**, this module runs that command in the child's cwd and
 * promotes the result to `verified` or rejects it. A criterion without a
 * `command` stays attested with the criterion listed as pending: the parent
 * confirms it from the child's pasted output instead of this module guessing
 * a project-unaware command (F32 / F44: semantic `must` strings are never
 * parsed either).
 */

import { spawn } from "node:child_process";
import { createCappedOutput, resolveMaxOutputBytes } from "../shared/output-cap.ts";
import { commandSummary, survivingDescendants, sweepProcessTree } from "../shared/proc-sweep.ts";
import { acquireVerifySlot, queueNote, resolveVerifyQueueConfig } from "./verify-queue.ts";
import type {
	AcceptanceCriterion,
	AcceptanceResult,
} from "../shared/types.ts";

export const DEFAULT_VERIFY_TIMEOUT_MS = 600_000;

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
	/**
	 * Cross-machine verify (S3, `cross-machine-spawn-v1` D14): why a non-zero code
	 * is not necessarily the child's fault.
	 *
	 * `code` — the command ran and failed: a verdict about the WORK.
	 * `timeout` / `unreachable` / `unknown-host` — the command did not run or did
	 * not finish: a verdict about the MACHINE, which must never be recorded as
	 * `rejected` (that sentence would say "the work does not pass" about work that
	 * was never measured). Absent ⇒ the local semantics, byte-identical.
	 */
	failure?: "code" | "timeout" | "unreachable" | "unknown-host";
	/** The machine that produced this result, when it was not this one. */
	host?: string;
	/** Human-readable detail for a non-`code` failure (and a clamp note). */
	failureDetail?: string;
}

export type VerifyRunner = (
	command: string,
	cwd: string,
	timeoutMs?: number,
) => Promise<CommandResult>;

export function needsVerification(
	criteria: AcceptanceCriterion[] | undefined,
): boolean {
	return (criteria ?? []).some(
		(criterion) =>
			criterion.severity !== "optional" &&
			(criterion.evidence ?? []).includes("verification-output"),
	);
}

/** Union of already-pending criteria and the un-runnable ones, deduped by id. */
function mergePending(
	acceptance: AcceptanceResult,
	criteria: AcceptanceCriterion[] | undefined,
): AcceptanceCriterion[] {
	const byId = new Map(
		(acceptance.pendingCriteria ?? []).map((c) => [c.id, c]),
	);
	for (const criterion of criteria ?? []) {
		if (criterion.severity === "optional") continue;
		if (!(criterion.evidence ?? []).includes("verification-output")) continue;
		if (criterion.command?.trim()) continue;
		byId.set(criterion.id, { ...criterion });
	}
	return [...byId.values()];
}

/**
 * The command this criterion is actually run with, else `undefined`.
 *
 * The ONE "is this criterion runnable" predicate (#393 review / D393-7):
 * required, `verification-output` evidence, non-empty `command`. The three
 * readers below — `verifyCommandsOf`, `verifyCommandOf` and the `carried`
 * filter inside `applyVerification` — all go through it, so a criterion that
 * one of them treats as pending can never be silently executed by another.
 */
function runnableCommandOf(criterion: AcceptanceCriterion): string | undefined {
	if (criterion.severity === "optional") return undefined;
	if (!(criterion.evidence ?? []).includes("verification-output")) return undefined;
	return criterion.command?.trim() || undefined;
}

/** All runnable verification commands, in declaration order. */
export function verifyCommandsOf(
	criteria: AcceptanceCriterion[] | undefined,
): string[] {
	const commands: string[] = [];
	for (const criterion of criteria ?? []) {
		const command = runnableCommandOf(criterion);
		if (command) commands.push(command);
	}
	return commands;
}

/** First required verification-output command, else undefined. */
export function verifyCommandOf(
	criteria: AcceptanceCriterion[] | undefined,
): string | undefined {
	for (const criterion of criteria ?? []) {
		const command = runnableCommandOf(criterion);
		if (command) return command;
	}
	return undefined;
}

/**
 * Budget for any child-supplied tail spliced into an `acceptance.reason`
 * (#393 review / D393-6). Verification output is capped on the red path; a
 * child's own `reason` is equally unbounded, and pasting it whole makes the
 * collect result unreadable and bloats every artifact that carries the reason.
 * Shared by both paths so the two caps cannot drift apart.
 */
const REASON_TAIL_LIMIT = 1_500;

/** `text` cut to `REASON_TAIL_LIMIT` chars, with the ellipsis counted inside it. */
function truncateReason(text: string): string {
	if (text.length <= REASON_TAIL_LIMIT) return text;
	return `${text.slice(0, REASON_TAIL_LIMIT - 1)}…`;
}

/**
 * demo-findings F2 / D2: what an INTERRUPTED turn gets instead of a verdict.
 *
 * The commands still run — the parent's own verify is the one measurement of the
 * worktree that exists, and skipping it leaves the parent with nothing. What must
 * not survive is the verdict: a turn that was stopped, failed or aborted and wrote
 * nothing cannot be "rejected" for its work, which is the same self-contradiction
 * `unknown` exists for ("a verdict about work that was not measured"). The tail
 * keeps the parent's measurement visible: it DID run, and its answer still says
 * something about the tree even though it says nothing about this turn.
 */
const INTERRUPTED_VERIFY_FAILED_REASON =
	"turn was interrupted, so its work was not assessed — the parent's verify still ran and failed";
const INTERRUPTED_VERIFY_PASSED_REASON =
	"turn was interrupted, so its work was not assessed — the parent's verify still ran and passed";

/**
 * Default verify runner: waits for a tree-wide verify slot (see
 * verify-queue.ts), then runs the command with its full timeout — queue wait
 * is not charged against `timeoutMs`.
 */
export async function defaultVerifyRunner(
	command: string,
	cwd: string,
	timeoutMs: number = DEFAULT_VERIFY_TIMEOUT_MS,
): Promise<CommandResult> {
	const config = resolveVerifyQueueConfig();
	const slot = await acquireVerifySlot(command, config);
	try {
		const result = await runVerifyCommand(command, cwd, timeoutMs);
		const note = queueNote(slot, config.limit);
		return note ? { ...result, stderr: `${note}${result.stderr}` } : result;
	} finally {
		slot.release();
	}
}

/**
 * Run one verify command now (no queue), output-capped and timed out.
 *
 * The shell runs in its **own process group** (`detached: true`) so the whole
 * tree can be swept when *we* end the command (#310). Doing so on the timeout,
 * output-cap and abort paths only — never on a normal exit — is deliberate:
 * `cmd &` inside a verification command is a legal way to leave a background
 * process behind, so a clean exit is reported (`survivingDescendants` + one
 * warning line) instead of killed. Because `close` waits for stdio to drain, a
 * command that already exited while an unredirected `cmd &` holds the pipes is
 * a clean exit too — the deadline only ends a command that is still running.
 */
export function runVerifyCommand(
	command: string,
	cwd: string,
	timeoutMs: number = DEFAULT_VERIFY_TIMEOUT_MS,
	signal?: AbortSignal,
): Promise<CommandResult> {
	const limit = timeoutMs > 0 ? timeoutMs : DEFAULT_VERIFY_TIMEOUT_MS;
	return new Promise((resolve) => {
		let settled = false;
		// Set once a sweep is running. A result that arrives mid-sweep is parked
		// and emitted when the sweep finishes, so the caller that sees a timeout
		// knows the descendants are already gone (#310).
		let sweep: Promise<unknown> | null = null;
		let parked = false;
		let leftoversReported = false;

		const cleanupAbort = () => {
			if (signal) signal.removeEventListener("abort", onAbort);
		};
		const emit = (result: CommandResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			cleanupAbort();
			resolve(result);
		};
		const finish = (result: CommandResult) => {
			if (settled) return;
			if (sweep) {
				if (parked) return;
				parked = true;
				void sweep.then(
					() => emit(result),
					() => emit(result),
				);
				return;
			}
			emit(result);
		};

		const child = spawn("bash", ["-lc", command], {
			cwd,
			env: process.env,
			// Own process group: `bash -lc` forks the real command, so a group id
			// derived from our own pid would make a tree-wide kill take the host
			// down with it (#310).
			detached: true,
		});

		const sweepTree = (): Promise<unknown> => {
			if (sweep) return sweep;
			const pid = child.pid;
			sweep = pid === undefined
				? Promise.resolve(null)
				: sweepProcessTree(pid).then(
					(result) => {
						// A survivor means a process outlived even SIGKILL (EPERM, a
						// container boundary). Never report that silently: the whole
						// point of the sweep is that a timeout can be trusted.
						if (result.survivors.length > 0) {
							console.warn(
								`[legion] verify command sweep left ${result.survivors.length} process(es) running: ${commandSummary(command)} (pids ${result.survivors.slice(0, 5).join(", ")}${result.survivors.length > 5 ? ", …" : ""})`,
							);
						}
						return result;
					},
					() => null,
				);
			return sweep;
		};
		const overflowed = () => out.truncated || err.truncated;
		const cap = resolveMaxOutputBytes();
		const killOnOverflow = () => {
			// Destroying the pipes makes any grandchild writer (bash -lc → cmd)
			// die of SIGPIPE instead of streaming into a closed-over buffer forever.
			child.stdout?.destroy();
			child.stderr?.destroy();
			sweepTree();
			clearTimeout(timer);
			finish({ code: 1, stdout: out.text(), stderr: err.text() });
		};
		const out = createCappedOutput(cap, killOnOverflow);
		const err = createCappedOutput(cap, killOnOverflow);
		child.stdout?.on("data", (chunk) => out.push(chunk));
		child.stderr?.on("data", (chunk) => err.push(chunk));
		const timer = setTimeout(() => {
			// `close` waits for stdio to drain, so an unredirected background job
			// (`bash -lc 'sleep 600 &'`) keeps it pending long after the command
			// itself finished. Once the direct child has exited the command is
			// over: report the leftovers and keep its own exit code instead of
			// mislabelling a success as a timeout and killing a legal process.
			const exited = child.exitCode;
			if (exited !== null) {
				reportLeftovers();
				finish({ code: overflowed() ? 1 : exited, stdout: out.text(), stderr: err.text() });
				return;
			}
			sweepTree();
			finish({
				code: 1,
				stdout: out.text(),
				stderr: `${err.text()}\nverification timed out after ${limit}ms`,
			});
		}, limit);
		function onAbort(): void {
			sweepTree();
			finish({
				code: 1,
				stdout: out.text(),
				stderr: `${err.text()}\nverification aborted`,
			});
		}
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		child.on("error", (error) => {
			clearTimeout(timer);
			finish({ code: 1, stdout: out.text(), stderr: String(error) });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (!sweep) reportLeftovers();
			finish({ code: overflowed() ? 1 : code ?? 1, stdout: out.text(), stderr: err.text() });
		});

		function reportLeftovers(): void {
			if (leftoversReported) return;
			leftoversReported = true;
			const pid = child.pid;
			if (pid === undefined) return;
			const survivors = survivingDescendants(pid);
			if (survivors.length === 0) return;
			console.warn(
				`[legion] verify command exited leaving ${survivors.length} process(es) running: ${commandSummary(command)} (pids ${survivors.slice(0, 5).join(", ")}${survivors.length > 5 ? ", …" : ""})`,
			);
		}
	});
}

export async function applyVerification(
	acceptance: AcceptanceResult,
	opts: {
		cwd: string;
		criteria?: AcceptanceCriterion[];
		run?: VerifyRunner;
		timeoutMs?: number;
		/**
		 * demo-findings F2 / D2: the turn behind this collect did not complete
		 * (`execution.status !== "success"` — the call site knows, this module must
		 * never re-derive it).
		 *
		 * The commands still run; only the VERDICT changes. A red command is not a
		 * verdict about an interrupted turn's work (`rejected` would claim work nobody
		 * measured was assessed), and a green one cannot make such a turn `verified`.
		 * Both answers are `unknown` and say which one happened.
		 *
		 * Absent ⇒ every pre-D2 answer is byte-identical.
		 */
		interrupted?: boolean;
	},
): Promise<AcceptanceResult> {
	// No `acceptance.status === "accepted"` gate here on purpose (#393). The
	// precondition for running verification is a required `verification-output`
	// criterion carrying an explicit `command` — not the child's own verdict
	// (`docs/design.md` §10.3). A child that self-reports `ok: false` must still
	// have its commands run; the reported status is kept either way, so nothing
	// is silently overturned (see the success path below).
	//
	// Whether to run at all is a separate question from what the child said: only
	// a TERMINAL collect is a result. The three non-terminal paths therefore never
	// reach this function, and the exclusion must stay outside it (#393 review /
	// D393-8):
	//   - aborted collect (`abortedSnapshot` / `interruptedCollect` in
	//     orchestrator.ts) — the turn was interrupted, so there is no verdict to
	//     verify and the worktree holds a half-written turn;
	//   - blocked collect (`blockedResult`) — the child is parked on a child-UI
	//     approval it is still waiting for; a command run there races that
	//     approval and cannot describe a finished state;
	//   - running snapshot — the collect deadline fired while the child is still
	//     alive. `finishCollect` skips this call for `status === "running"`: a
	//     snapshot of a live, still-writing worktree is not a result, the deadline
	//     has already elapsed (`Math.max(5_000, deadline - now)` is therefore
	//     almost always ~5s, so a real command times out and manufactures a fake
	//     `rejected`/`verified`), and the tree-wide verify-slot wait is not charged
	//     against that timeout at all.
	if (!needsVerification(opts.criteria)) return acceptance;

	const commands = verifyCommandsOf(opts.criteria);
	// No explicit command on the criterion: do not guess one. The project's own
	// verifier only the child/parent can know — running a hardcoded default
	// here would verify the wrong thing on every non-Node project. Keep the
	// result attested and surface the criteria as pending for the parent.
	if (commands.length === 0) {
		return {
			...acceptance,
			level: "attested",
			reason:
				"verification-output criterion has no command; confirm from the child's pasted output",
			pendingCriteria: mergePending(acceptance, opts.criteria),
		};
	}
	const run = opts.run ?? defaultVerifyRunner;
	// Criteria the loop below actually executes (verified or failed) are resolved
	// here — they never stay "pending for the parent to confirm". Everything else
	// is carried VERBATIM (#393 review / D393-7): a pending criterion can carry a
	// `command` this module still never runs (optional severity, or no
	// `verification-output` evidence), and dropping it by `command` alone silently
	// deleted the parent's only reminder. The filter is `runnableCommandOf`, the
	// same predicate `verifyCommandsOf` uses above, so "kept pending" and "run"
	// cannot disagree.
	const carried = (acceptance.pendingCriteria ?? []).filter(
		(criterion) => runnableCommandOf(criterion) === undefined,
	);
	// Run every command in order; stop at the first failure so the rejection
	// names the command that actually broke, not a later one that never ran.
	let ranOn: string | undefined;
	for (const command of commands) {
		const result = await run(command, opts.cwd, opts.timeoutMs);
		if (result.host) ranOn = result.host;
		// D14 (S3): a machine failure is NOT a code failure. The class decides the
		// verdict — `unknown` keeps the parent asking instead of recording a rejection
		// about work nobody measured. `code`, or no `failure` at all (the local shape),
		// keeps the pre-S3 wording byte for byte.
		if (result.failure !== undefined && result.failure !== "code") {
			const where = result.host ? ` on host '${result.host}'` : "";
			const detail = (result.failureDetail ?? result.failure).trim();
			return {
				...acceptance,
				status: "unknown",
				level: acceptance.level === "verified" ? "attested" : acceptance.level,
				reason: `verification unavailable${where} (${result.failure}): ${detail.slice(0, REASON_TAIL_LIMIT)}`,
				pendingCriteria: carried,
			};
		}
		const output = `${result.stdout}\n${result.stderr}`.trim();
		if (result.code === 0) continue;
		// demo-findings F2 / D2: a red command on an INTERRUPTED turn is a fact about
		// the tree, not a rejection of work that was never assessed.
		if (opts.interrupted) {
			return {
				...acceptance,
				status: "unknown",
				level: "attested",
				reason: INTERRUPTED_VERIFY_FAILED_REASON,
				pendingCriteria: carried,
			};
		}
		const where = result.host ? ` on host '${result.host}'` : "";
		return {
			...acceptance,
			status: "rejected",
			level: "attested",
			reason: `verification failed${where} (\`${command}\`): ${output.slice(0, REASON_TAIL_LIMIT)}`,
			pendingCriteria: carried,
		};
	}
	// The machine is part of the fact: "verified by `npm test`" on ANOTHER host is a
	// claim about that machine's checkout, and the verdict must say so (S3).
	const verifiedReason = `verified by ${commands.map((c) => `\`${c}\``).join(" && ")}${ranOn ? ` on host '${ranOn}'` : ""}`;
	// demo-findings F2 / D2: the commands passed, but they judged the TREE, not a
	// turn that never produced anything. `verified` is a claim about evidence for
	// THIS turn's work, so it is withheld here — the fact (and whose it is) is in
	// the reason instead.
	if (opts.interrupted) {
		return {
			...acceptance,
			status: "unknown",
			level: "attested",
			reason: INTERRUPTED_VERIFY_PASSED_REASON,
			pendingCriteria: carried,
		};
	}
	if (acceptance.status !== "accepted") {
		// The commands did pass, so the level is `verified` — but the status the
		// child reported stands verbatim, and its reason is kept alongside ours
		// instead of being overwritten (#393 / D393-2). The child's own reason is
		// capped like the red path's output is, ellipsis included (#393 review /
		// D393-6).
		const ownReason = acceptance.reason?.trim();
		return {
			...acceptance,
			level: "verified",
			reason: ownReason
				? `${verifiedReason} — the child's own verdict still stands (${truncateReason(ownReason)})`
				: verifiedReason,
			pendingCriteria: carried,
		};
	}
	return {
		...acceptance,
		status: "accepted",
		level: "verified",
		// Name every command that had to pass, not just the first.
		reason: verifiedReason,
		pendingCriteria: carried,
	};
}
