import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	GIT_PROBE_TIMEOUT_MS,
	GIT_WORKTREE_TIMEOUT_MS,
	isGitRepo,
	isInsideChildWorktree,
} from "../../src/runs/worktree.ts";

function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function initRepo(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "wt-timeout-"));
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

/**
 * The probe budget must be loose enough that a healthy local repo never trips
 * it. If this fails, the timeout is being charged to something that is not a
 * plumbing probe (a hung NFS/network path), which is exactly what the budget
 * exists to bound rather than freeze on.
 */
test("a rev-parse probe stays well inside GIT_PROBE_TIMEOUT_MS", { skip: !hasGit() }, () => {
	const repo = initRepo();
	const sub = path.join(repo, "src", "legion");
	try {
		mkdirSync(sub, { recursive: true });
		for (const cwd of [repo, sub]) {
			const started = process.hrtime.bigint();
			assert.equal(isInsideChildWorktree(cwd), false, `probe succeeds for ${cwd}`);
			const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
			assert.ok(
				elapsedMs < GIT_PROBE_TIMEOUT_MS,
				`rev-parse probe took ${elapsedMs.toFixed(1)}ms, budget is ${GIT_PROBE_TIMEOUT_MS}ms`,
			);
		}
		assert.equal(isGitRepo(repo), true, "isGitRepo probe succeeds inside its budget");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

/**
 * The mutating budget must be the *bigger* one. `worktree add` copies a
 * checkout and may run a slow post-checkout hook; giving it the probe budget
 * would turn a slow-but-healthy clone into a spurious START_FAILED.
 */
test("mutating worktree commands get a bigger budget than the plumbing probes", () => {
	assert.ok(
		GIT_WORKTREE_TIMEOUT_MS > GIT_PROBE_TIMEOUT_MS,
		`GIT_WORKTREE_TIMEOUT_MS (${GIT_WORKTREE_TIMEOUT_MS}) must exceed GIT_PROBE_TIMEOUT_MS (${GIT_PROBE_TIMEOUT_MS})`,
	);
});
