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
import type {
	AcceptanceCriterion,
	AcceptanceResult,
} from "../shared/types.ts";

export const DEFAULT_VERIFY_TIMEOUT_MS = 600_000;

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
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

/** All runnable verification commands, in declaration order. */
export function verifyCommandsOf(
	criteria: AcceptanceCriterion[] | undefined,
): string[] {
	const commands: string[] = [];
	for (const criterion of criteria ?? []) {
		if (criterion.severity === "optional") continue;
		if (!(criterion.evidence ?? []).includes("verification-output")) continue;
		const command = criterion.command?.trim();
		if (command) commands.push(command);
	}
	return commands;
}

/** First required verification-output command, else undefined. */
export function verifyCommandOf(
	criteria: AcceptanceCriterion[] | undefined,
): string | undefined {
	for (const criterion of criteria ?? []) {
		if (criterion.severity === "optional") continue;
		if (!(criterion.evidence ?? []).includes("verification-output")) continue;
		const command = criterion.command?.trim();
		if (command) return command;
	}
	return undefined;
}

export function defaultVerifyRunner(
	command: string,
	cwd: string,
	timeoutMs: number = DEFAULT_VERIFY_TIMEOUT_MS,
): Promise<CommandResult> {
	const limit = timeoutMs > 0 ? timeoutMs : DEFAULT_VERIFY_TIMEOUT_MS;
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: CommandResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		const child = spawn("bash", ["-lc", command], {
			cwd,
			env: process.env,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2_000);
			finish({
				code: 1,
				stdout,
				stderr: `${stderr}\nverification timed out after ${limit}ms`,
			});
		}, limit);
		child.on("error", (error) => {
			clearTimeout(timer);
			finish({ code: 1, stdout, stderr: String(error) });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			finish({ code: code ?? 1, stdout, stderr });
		});
	});
}

export async function applyVerification(
	acceptance: AcceptanceResult,
	opts: {
		cwd: string;
		criteria?: AcceptanceCriterion[];
		run?: VerifyRunner;
		timeoutMs?: number;
	},
): Promise<AcceptanceResult> {
	if (acceptance.status !== "accepted") return acceptance;
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
	// Command-bearing criteria are resolved mechanically below — verified or
	// failed, they never stay "pending for the parent to confirm". Only
	// no-command criteria remain in pending (mergePending above), which is
	// what the unverified-criteria banner is for.
	const carried = (acceptance.pendingCriteria ?? []).filter(
		(criterion) => !criterion.command?.trim(),
	);
	// Run every command in order; stop at the first failure so the rejection
	// names the command that actually broke, not a later one that never ran.
	for (const command of commands) {
		const result = await run(command, opts.cwd, opts.timeoutMs);
		const output = `${result.stdout}\n${result.stderr}`.trim();
		if (result.code === 0) continue;
		return {
			...acceptance,
			status: "rejected",
			level: "attested",
			reason: `verification failed (\`${command}\`): ${output.slice(0, 1_500)}`,
			pendingCriteria: carried,
		};
	}
	return {
		...acceptance,
		status: "accepted",
		level: "verified",
		// Name every command that had to pass, not just the first.
		reason: `verified by ${commands.map((c) => `\`${c}\``).join(" && ")}`,
		pendingCriteria: carried,
	};
}
