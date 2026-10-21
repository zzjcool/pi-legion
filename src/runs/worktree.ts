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
 * Budget for the git plumbing probes (`rev-parse`): a handful of stat/read on
 * the repo metadata, measured in single-digit milliseconds on a warm local
 * checkout. 5s is ~1000x headroom, and short enough that a hung NFS/network
 * path (see the #227-series bare-child hangs) surfaces as a probe failure
 * instead of freezing the parent event loop.
 *
 * NOT the budget for mutating commands — see GIT_WORKTREE_TIMEOUT_MS.
 */
export const GIT_PROBE_TIMEOUT_MS = 5_000;

/**
 * Budget for `git worktree add` / `git worktree remove`. These copy the checkout
 * and may run hooks or a slow `post-checkout`, so they need a far bigger budget
 * than the probes: 120s is generous for a large repo on slow storage while still
 * bounding a hang. Deliberately separate from GIT_PROBE_TIMEOUT_MS — one shared
 * value would either be absurdly loose for `rev-parse` or too tight for `add`.
 */
export const GIT_WORKTREE_TIMEOUT_MS = 120_000;

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
 * Detected by comparing the cwd's git dir against the repository's common git
 * dir: they are the same path in a main checkout and differ inside any linked
 * worktree (including ones created by other agent runs).
 *
 * ## Why the paths are resolved before comparing (#237 P10)
 *
 * A raw string compare of the two paths is wrong. From a *subdirectory* of a
 * normal repo git reports them inconsistently: `--git-dir` comes back absolute
 * (`/repo/.git`) while `--git-common-dir` stays relative (`../../.git`), so the
 * compare claims "inside a linked worktree" for every subdirectory of a plain
 * repo — silently suppressing worktree creation for launches whose cwd is one.
 * Both values are therefore requested with `--path-format=absolute` so they are
 * resolved by git itself.
 *
 * ## Old git cannot corrupt the answer
 *
 * `--path-format` needs git >= 2.31. Older git does not reject the unknown long
 * option — `rev-parse` treats it as a REVISION and echoes it, exiting 0 with
 * `--path-format=absolute\n.git\n.git` (verified: any `--fake-flag=x` behaves
 * this way). An unvalidated 2-line parse would then take the flag string as
 * `gitDir`, see it differ from `commonDir`, and return true for EVERY repo
 * including main-checkout roots — strictly worse than the bug being fixed.
 * The parsed shape is therefore validated strictly (exactly two non-empty
 * absolute paths) and, when git answers in any other shape, the call falls back
 * to `probeLegacyGitDirs`, which resolves the relative path against the REAL
 * cwd. A throw (non-git cwd, or the timeout firing) is not a shape problem and
 * is never retried: it reports false, so one hang costs one budget, not three.
 *
 * Supported minimum: git 2.31 (2021-03). On anything older the fallback runs
 * and produces identical answers — pinned by a shim test that emulates the
 * echo, plus a direct test of the fallback against real fixtures.
 *
 * Non-git directories make `rev-parse` exit 128 (it does NOT report `.git` for
 * both); the throw is swallowed and treated as not-in-worktree. The later
 * createChildWorktree call owns the "not a repo" error.
 *
 * `fs.realpathSync` is deliberately NOT applied to the resolved pair: git
 * already canonicalizes its first path segment via getcwd(), so a symlinked
 * cwd reports a consistent absolute pair for repo roots, repo subdirectories
 * and symlinked linked-worktree paths alike (verified). It IS applied in the
 * legacy fallback, where the relative path must be resolved against the real
 * cwd rather than the symlinked one.
 */
export function isInsideChildWorktree(cwd: string): boolean {
	try {
		const out = execFileSync(
			"git",
			["-C", cwd, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
			{
				stdio: ["ignore", "pipe", "pipe"],
				encoding: "utf8",
				timeout: GIT_PROBE_TIMEOUT_MS,
			},
		).trim();
		const pair = parseAbsoluteGitDirs(out);
		// git answered, but not in the shape --path-format promises: the option was
		// echoed back as a revision (git < 2.31). Never guess from that output —
		// re-probe the portable way.
		if (!pair) return probeLegacyGitDirs(cwd);
		return pair[0] !== pair[1];
	} catch {
		// git refused or never answered (non-git cwd exits 128; a hung path hits
		// the timeout). Both mean "not a child worktree", and neither justifies a
		// second and third probe — that would multiply a single budget by three.
		return false;
	}
}

/**
 * Capability test for `--path-format` (git >= 2.31), and the shape guard that
 * makes it safe: returns the two git-dir paths only when git answered with
 * exactly two non-empty absolute paths.
 *
 * There is deliberately no separate capability probe or cache — one would cost
 * a process on every supported call and, worse, a probe that times out on a hung
 * path would have to be cached as a lie ("unsupported") or re-paid forever.
 * This runs on output the caller already had to fetch, and rejects what old git
 * produces (an echoed option, a third line, or a lone `.git`).
 */
function parseAbsoluteGitDirs(out: string): [string, string] | null {
	const lines = out
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	if (lines.length !== 2) return null;
	const [gitDir, commonDir] = lines as [string, string];
	// Requires both paths absolute. Note this is `path.isAbsolute`, which is
	// platform-specific: on Windows `path.isAbsolute("C:/foo")` is true, so native
	// `C:/...` output passes here and the legacy probe is NOT reached. The
	// rejection branch only fires for a genuinely relative/non-path line, which
	// is what an old git echoing the option produces on every platform.
	if (!path.isAbsolute(gitDir) || !path.isAbsolute(commonDir)) return null;
	return [gitDir, commonDir];
}

/**
 * Portable probe for git < 2.31: two plain `rev-parse` calls, then resolve both
 * results against the REAL cwd. `--git-dir` may come back absolute while
 * `--git-common-dir` is relative to the cwd, so a raw compare is meaningless —
 * and `path.resolve(cwd, ...)` alone is not enough either: with a symlinked cwd
 * git anchors its output at the symlink TARGET, so resolving against the
 * symlinked spelling reintroduces the very subdirectory false positive this
 * branch exists to fix (verified: /tmp/link->/tmp/repo, cwd /tmp/link/a yields
 * `/tmp/repo/.git` vs `../../.git`, which resolves to `/tmp/.git`).
 *
 * This IS the capability fallback referenced above.
 *
 * Exported for the regression test that pins the fallback's semantics without
 * requiring an actual old git on the machine.
 */
export function probeLegacyGitDirs(cwd: string): boolean {
	try {
		const read = (flag: string): string =>
			execFileSync("git", ["-C", cwd, "rev-parse", flag], {
				stdio: ["ignore", "pipe", "pipe"],
				encoding: "utf8",
				timeout: GIT_PROBE_TIMEOUT_MS,
			}).trim();
		const gitDir = read("--git-dir");
		const commonDir = read("--git-common-dir");
		if (gitDir === "" || commonDir === "") return false;
		const realCwd = fs.realpathSync(cwd);
		return path.resolve(realCwd, gitDir) !== path.resolve(realCwd, commonDir);
	} catch {
		// Non-git cwd (rev-parse exits 128), hung git, vanished directory: all
		// "not a child worktree", matching what the modern path reports.
		return false;
	}
}

/** Branch the child commits on. Unique per launch so two workers never collide. */
export function worktreeBranchFor(name: string, nonce?: string): string {
	const tag = nonce ?? randomBytes(4).toString("hex");
	return `pi-subagent/${sanitizeNameForFs(name)}-${tag}`;
}

/**
 * Whether the cwd sits in a work tree. Tri-state on purpose: a probe that
 * could not run (timeout / spawn failure) is NOT the same finding as "this is
 * not a repo", and callers word their error differently for each.
 */
type RepoProbe = "repo" | "not-a-repo" | "unavailable";

function probeRepo(cwd: string): RepoProbe {
	try {
		execFileSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
			stdio: "ignore",
			timeout: GIT_PROBE_TIMEOUT_MS,
		});
		return "repo";
	} catch (error) {
		// A hung path is surfaced as deferred truth, not as a verdict on the cwd.
		return isTimeoutError(error) ? "unavailable" : "not-a-repo";
	}
}

export function isGitRepo(cwd: string): boolean {
	return probeRepo(cwd) === "repo";
}

function isTimeoutError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const { code, signal } = error as { code?: unknown; signal?: unknown };
	return code === "ETIMEDOUT" || code === "ABORT_ERR" || signal === "SIGTERM";
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
	const probe = probeRepo(opts.repoCwd);
	if (probe !== "repo") {
		// Distinguish "you pointed at the wrong directory" from "git did not
		// answer": the first is a caller mistake (INVALID_PARAMS), the second is
		// an environment failure (START_FAILED) and must not accuse the path.
		if (probe === "unavailable") {
			throw new SubagentError(
				`worktree: true could not inspect ${opts.repoCwd}: git did not answer within ${GIT_PROBE_TIMEOUT_MS}ms`,
				ErrorCodes.START_FAILED,
			);
		}
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
				{ stdio: ["ignore", "pipe", "pipe"], timeout: GIT_WORKTREE_TIMEOUT_MS },
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
	if (error && typeof error === "object") {
		const { stderr, message, code } = error as {
			stderr?: Buffer | string | null;
			message?: unknown;
			code?: unknown;
		};
		const detail = stderr === undefined || stderr === null ? "" : String(stderr).trim();
		if (detail !== "") return detail;
		// A timeout kill leaves stderr EMPTY (no git output, just SIGTERM), so the
		// stderr-only extraction used to yield "" and the operator saw a bare
		// "git worktree add failed: " with no diagnostic. Fall through to the
		// Error message ("spawnSync git ETIMEDOUT") and then the code.
		if (typeof message === "string" && message !== "") return message;
		if (typeof code === "string" && code !== "") return code;
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
			{ stdio: "ignore", timeout: GIT_WORKTREE_TIMEOUT_MS },
		);
	} catch {
		try {
			fs.rmSync(opts.dest, { recursive: true, force: true });
		} catch {
			/* leftover directory is diagnostic, not fatal */
		}
	}
}
