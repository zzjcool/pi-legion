/**
 * Per-child git worktree isolation.
 *
 * Only the `centurion` role may hold `worktree: true` (#214 / contract §9).
 * Squad members work in-place inside the centurion subtree (or parent cwd).
 * When isolation is granted, the child gets its own branch under the run
 * directory (`git worktree add -b`); retire leaves the tree on disk (same
 * rationale as keeping the session file).
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ErrorCodes, SubagentError } from "../shared/types.ts";
import { sanitizeNameForFs } from "./store.ts";

export function worktreePathFor(runDir: string, name: string): string {
	return path.join(runDir, "worktrees", sanitizeNameForFs(name));
}

/**
 * Who decides whether this launch gets an isolated worktree.
 *
 * Per-step tool field wins, then the top-level `subagent({ worktree })`
 * argument, then the role default. The parent (group) agent is supposed to
 * pick this; the role default is only the fallback when it omits the field.
 *
 * Nesting suppression: when the parent cwd is itself a child worktree
 * (git-dir ≠ git-common-dir), the role default and launch fallback collapse
 * to false — a worktree of a worktree only re-pays the bootstrap tax.
 * Explicit `launch: true`/`step: true` still wins: the caller saw the
 * suppression and insisted.
 */
export function resolveLaunchWorktree(opts: {
	roleDefault?: boolean;
	launch?: boolean;
	step?: boolean;
	parentInWorktree?: boolean;
}): boolean {
	if (typeof opts.step === "boolean") return opts.step;
	if (typeof opts.launch === "boolean") return opts.launch;
	if (opts.parentInWorktree) return false;
	return opts.roleDefault === true;
}

/**
 * True when cwd is itself a linked git worktree (child of a main checkout).
 * Detected via `git rev-parse --git-dir` vs `--git-common-dir`: they differ
 * inside any linked worktree, including ones created by other agent runs.
 * Non-git directories report both as ".git" and are treated as not-in-worktree;
 * the later createChildWorktree call owns the "not a repo" error.
 */
export function isInsideChildWorktree(cwd: string): boolean {
	try {
		const gitDir = execFileSync("git", ["-C", cwd, "rev-parse", "--git-dir"], {
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf8",
		}).trim();
		const commonDir = execFileSync(
			"git",
			["-C", cwd, "rev-parse", "--git-common-dir"],
			{ stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
		).trim();
		return gitDir !== commonDir && gitDir !== "" && commonDir !== "";
	} catch {
		return false;
	}
}

/** Branch the child commits on. Unique per launch so two workers never collide. */
export function worktreeBranchFor(name: string, nonce?: string): string {
	const tag = nonce ?? randomBytes(4).toString("hex");
	return `pi-subagent/${sanitizeNameForFs(name)}-${tag}`;
}

export function isGitRepo(cwd: string): boolean {
	try {
		execFileSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

export interface ChildWorktree {
	path: string;
	branch: string;
}

export function createChildWorktree(opts: {
	repoCwd: string;
	runDir: string;
	name: string;
}): ChildWorktree {
	if (!isGitRepo(opts.repoCwd)) {
		throw new SubagentError(
			`worktree: true requires a git repository; ${opts.repoCwd} is not one`,
			ErrorCodes.INVALID_PARAMS,
		);
	}
	const dest = worktreePathFor(opts.runDir, opts.name);
	fs.mkdirSync(path.dirname(dest), { recursive: true });

	let lastMessage = "git worktree add failed";
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const branch = worktreeBranchFor(opts.name);
		try {
			execFileSync(
				"git",
				["-C", opts.repoCwd, "worktree", "add", "-b", branch, dest, "HEAD"],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			return { path: dest, branch };
		} catch (error) {
			lastMessage = worktreeErrorMessage(error);
			if (!/already exists|already used|busy/i.test(lastMessage)) {
				throw new SubagentError(
					`git worktree add failed: ${lastMessage.slice(0, 500)}`,
					ErrorCodes.START_FAILED,
				);
			}
		}
	}
	throw new SubagentError(
		`git worktree add failed: ${lastMessage.slice(0, 500)}`,
		ErrorCodes.START_FAILED,
	);
}

function worktreeErrorMessage(error: unknown): string {
	if (error && typeof error === "object" && "stderr" in error) {
		return String((error as { stderr?: Buffer | string }).stderr ?? error);
	}
	return String(error);
}

/** Best-effort rollback when launch fails after the worktree was created. */
export function removeChildWorktree(opts: {
	repoCwd: string;
	dest: string;
}): void {
	try {
		execFileSync(
			"git",
			["-C", opts.repoCwd, "worktree", "remove", "--force", opts.dest],
			{ stdio: "ignore" },
		);
	} catch {
		try {
			fs.rmSync(opts.dest, { recursive: true, force: true });
		} catch {
			/* leftover directory is diagnostic, not fatal */
		}
	}
}
