import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	createChildWorktree,
	isGitRepo,
	isInsideChildWorktree,
	removeChildWorktree,
	resolveLaunchWorktree,
	worktreeBranchFor,
	worktreePathFor,
} from "../../src/runs/worktree.ts";
import { ErrorCodes, SubagentError } from "../../src/shared/types.ts";

function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function initRepo(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "wt-repo-"));
	execFileSync("git", ["-C", dir, "init"], { stdio: "ignore" });
	writeFileSync(path.join(dir, "README"), "hi\n");
	execFileSync("git", ["-C", dir, "add", "README"], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "commit", "-m", "init"], {
		stdio: "ignore",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
	});
	return dir;
}

/** Real directories (git has no tracked files to create them for us). */
function mkdirs(...dirs: string[]): void {
	for (const dir of dirs) mkdirSync(dir, { recursive: true });
}

test("worktreePathFor nests under the run dir", () => {
	assert.equal(
		worktreePathFor("/tmp/run", "worker-0"),
		path.join("/tmp/run", "worktrees", "worker-0"),
	);
});

test("resolveLaunchWorktree lets the parent override the role default", () => {
	assert.equal(resolveLaunchWorktree({ roleDefault: true }), true);
	assert.equal(resolveLaunchWorktree({ roleDefault: false }), false);
	assert.equal(resolveLaunchWorktree({}), false);
	assert.equal(
		resolveLaunchWorktree({ roleDefault: true, launch: false }),
		false,
	);
	assert.equal(
		resolveLaunchWorktree({ roleDefault: false, launch: true }),
		true,
	);
	assert.equal(
		resolveLaunchWorktree({
			roleDefault: true,
			launch: false,
			step: true,
		}),
		true,
		"per-child field wins over the top-level launch flag",
	);
});

test("resolveLaunchWorktree suppresses role default when the parent sits in a child worktree", () => {
	assert.equal(
		resolveLaunchWorktree({ roleDefault: true, parentInWorktree: true }),
		false,
		"role default collapses inside a child worktree",
	);
	assert.equal(
		resolveLaunchWorktree({ parentInWorktree: true }),
		false,
	);
	assert.equal(
		resolveLaunchWorktree({
			roleDefault: true,
			launch: true,
			parentInWorktree: true,
		}),
		true,
		"explicit launch flag wins over suppression",
	);
	assert.equal(
		resolveLaunchWorktree({
			roleDefault: true,
			step: true,
			parentInWorktree: true,
		}),
		true,
		"explicit per-child field wins over suppression",
	);
	assert.equal(
		resolveLaunchWorktree({ roleDefault: true, launch: false, parentInWorktree: false }),
		false,
		"suppression off: role default still applies outside worktrees",
	);
});

test("isInsideChildWorktree detects linked worktrees only", () => {
	if (!hasGit()) return;
	const repo = initRepo();
	try {
		assert.equal(isInsideChildWorktree(repo), false, "plain repo is not a child worktree");
		const wt = mkdtempSync(path.join(tmpdir(), "wt-linked-"));
		rmSync(wt, { recursive: true });
		execFileSync("git", ["-C", repo, "worktree", "add", "-b", "probe-wt", wt], {
			stdio: "ignore",
		});
		try {
			assert.equal(isInsideChildWorktree(wt), true, "linked worktree is detected");
		} finally {
			execFileSync("git", ["-C", repo, "worktree", "remove", "--force", wt], {
				stdio: "ignore",
			});
		}
		assert.equal(isInsideChildWorktree(tmpdir()), false, "non-git dir reports false, not throw");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

/**
 * #237 P10 regression. A subdirectory must answer exactly like its repo root.
 *
 * Pre-fix this asserted `false` for `repo/src/legion` on the *left* comparison
 * and failed there: `--git-dir` is absolute from a subdirectory while
 * `--git-common-dir` is relative, so the plain string compare saw "different"
 * and reported every subdirectory of a plain repo as a linked worktree. That
 * false positive silently suppressed worktree creation for launches whose cwd
 * was a subdirectory of a normal checkout.
 */
test("isInsideChildWorktree answers the same for a repo root and its subdirectories", {
	skip: !hasGit(),
}, () => {
	const repo = initRepo();
	const wt = path.join(mkdtempSync(path.join(tmpdir(), "wt-sub-")), "linked");
	const repoSub = path.join(repo, "src", "legion");
	const wtSub = path.join(wt, "src", "legion");
	try {
		mkdirs(repoSub);
		execFileSync("git", ["-C", repo, "worktree", "add", "-b", "probe-sub", wt], {
			stdio: "ignore",
		});
		mkdirs(wtSub);

		// Plain checkout: root and every depth below it are "not a child worktree".
		assert.equal(isInsideChildWorktree(repo), false, "plain repo root");
		assert.equal(isInsideChildWorktree(path.join(repo, "src")), false, "plain repo 1 level deep");
		assert.equal(
			isInsideChildWorktree(repoSub),
			false,
			"plain repo subdirectory must answer like its root (this is the #237 bug)",
		);

		// Linked worktree: root and every depth below it are "inside a child worktree".
		assert.equal(isInsideChildWorktree(wt), true, "linked worktree root");
		assert.equal(
			isInsideChildWorktree(wtSub),
			true,
			"linked worktree subdirectory must answer like its root",
		);

		// The root/subdirectory answer is identical by construction — state it once
		// as an explicit invariant so a future short-circuit cannot drift.
		assert.equal(
			isInsideChildWorktree(repoSub),
			isInsideChildWorktree(repo),
			"plain repo: subdirectory == root",
		);
		assert.equal(
			isInsideChildWorktree(wtSub),
			isInsideChildWorktree(wt),
			"linked worktree: subdirectory == root",
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(path.dirname(wt), { recursive: true, force: true });
	}
});

/**
 * Companion guard for the #237 assertion above: a plain checkout must answer
 * `false` at every depth, including from a subdirectory whose cwd is itself a
 * *symlink* into the checkout. `git rev-parse --git-dir` reports an absolute
 * path anchored at the symlink target while `--git-common-dir` reports a
 * relative one, so this is precisely the shape that makes a naive
 * "resolve both against `cwd`" fix reintroduce the false positive.
 */
test("a plain checkout answers false from a symlinked subdirectory too", {
	skip: !hasGit(),
}, () => {
	const repo = initRepo();
	const sub = path.join(repo, "src", "legion");
	const linkParent = mkdtempSync(path.join(tmpdir(), "wt-symlink-"));
	const link = path.join(linkParent, "via-link");
	try {
		mkdirs(sub);
		symlinkSync(repo, link);
		for (const cwd of [repo, sub]) {
			assert.equal(isInsideChildWorktree(cwd), false, `plain checkout probe for ${cwd}`);
		}
		assert.equal(
			isInsideChildWorktree(path.join(link, "src", "legion")),
			false,
			"a symlinked subdirectory of a plain checkout is still not a child worktree",
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(linkParent, { recursive: true, force: true });
	}
});

test("createChildWorktree refuses a non-git cwd", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "wt-nogit-"));
	try {
		assert.equal(isGitRepo(dir), false);
		assert.throws(
			() =>
				createChildWorktree({
					repoCwd: dir,
					runDir: path.join(dir, "run"),
					name: "w",
				}),
			(error: unknown) =>
				error instanceof SubagentError &&
				error.code === ErrorCodes.INVALID_PARAMS,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createChildWorktree adds a named branch checkout and remove rolls it back", {
	skip: !hasGit(),
}, () => {
	const repo = initRepo();
	const runDir = mkdtempSync(path.join(tmpdir(), "wt-run-"));
	try {
		const tree = createChildWorktree({
			repoCwd: repo,
			runDir,
			name: "worker-0",
		});
		assert.ok(existsSync(path.join(tree.path, "README")));
		assert.equal(tree.path, worktreePathFor(runDir, "worker-0"));
		assert.match(tree.branch, /^pi-subagent\/worker-0-[0-9a-f]{8}$/);
		const head = execFileSync(
			"git",
			["-C", tree.path, "rev-parse", "--abbrev-ref", "HEAD"],
			{ encoding: "utf8" },
		).trim();
		assert.equal(head, tree.branch);
		assert.notEqual(head, "HEAD", "must not be a detached checkout");
		removeChildWorktree({ repoCwd: repo, dest: tree.path });
		assert.equal(existsSync(tree.path), false);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("worktreeBranchFor is unique per nonce", () => {
	assert.equal(
		worktreeBranchFor("worker-0", "deadbeef"),
		"pi-subagent/worker-0-deadbeef",
	);
	assert.notEqual(worktreeBranchFor("worker-0"), worktreeBranchFor("worker-0"));
});
