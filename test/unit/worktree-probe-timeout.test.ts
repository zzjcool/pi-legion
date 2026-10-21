/**
 * Behavioural coverage for the git budgets in `src/runs/worktree.ts` (#237 B).
 *
 * The probe that used to live here asserted `GIT_WORKTREE_TIMEOUT_MS >
 * GIT_PROBE_TIMEOUT_MS` — two literals in the same file, referencing no call
 * site, so deleting every `timeout:` key in the module left it green. It is
 * replaced by real fixtures that fake `git` on PATH:
 *
 *   1. a shim that never answers, proving the two probes actually stop waiting
 *      and report the right outcome (`false`, and START_FAILED for launch);
 *   2. a shim that fails `worktree add` with EMPTY stderr, proving the error
 *      message still carries a diagnostic instead of rendering "failed: ";
 *   3. a shim that emulates git < 2.31 by echoing `--path-format=...` as a
 *      revision, proving the worktree-dir probe cannot be fooled into
 *      reporting a main checkout as a linked worktree;
 *   4. a source-level wiring assertion that every `execFileSync("git", ...)`
 *      call site carries a `timeout:` on the budget its comment justifies —
 *      this is what actually breaks if the wiring is removed.
 *
 * Kept in its own file so `worktree.test.ts` imports only symbols that predate
 * the timeout hardening: that file has to stay copyable onto a pristine
 * `origin/master` export to prove the subdirectory regression fails there on
 * an *assertion* rather than on a missing export.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createChildWorktree,
	GIT_PROBE_TIMEOUT_MS,
	GIT_WORKTREE_TIMEOUT_MS,
	isGitRepo,
	isInsideChildWorktree,
	probeLegacyGitDirs,
} from "../../src/runs/worktree.ts";
import { ErrorCodes, SubagentError } from "../../src/shared/types.ts";

const MODULE_PATH = fileURLToPath(new URL("../../src/runs/worktree.ts", import.meta.url));

function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** Absolute path of the real git, resolved before any shim touches PATH. */
function realGitPath(): string {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (dir === "") continue;
		const candidate = path.join(dir, "git");
		if (existsSync(candidate)) return candidate;
	}
	throw new Error("no git on PATH");
}

interface GitShim {
	restore(): void;
}

/**
 * Prepend a fake `git` to PATH. `body` runs in CommonJS with `args` bound to
 * the argv tail and `real` bound to the real git binary.
 */
function installGitShim(body: string): GitShim {
	const dir = mkdtempSync(path.join(tmpdir(), "wt-gitshim-"));
	const shim = path.join(dir, "git");
	writeFileSync(
		shim,
		`#!/usr/bin/env node\n"use strict";\nconst { execFileSync } = require("node:child_process");\n` +
			`const args = process.argv.slice(2);\nconst real = process.env.WT_REAL_GIT;\n${body}\n`,
	);
	chmodSync(shim, 0o755);
	const previousPath = process.env.PATH;
	const previousReal = process.env.WT_REAL_GIT;
	process.env.WT_REAL_GIT = realGitPath();
	process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ""}`;
	return {
		restore() {
			process.env.PATH = previousPath;
			if (previousReal === undefined) delete process.env.WT_REAL_GIT;
			else process.env.WT_REAL_GIT = previousReal;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** Delegate to the real git, mirroring its stdout/stderr/exit code. */
const DELEGATE = `
function run(a) {
	try {
		return { out: execFileSync(real, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), code: 0 };
	} catch (e) {
		return { out: "", err: String(e.stderr ?? ""), code: typeof e.status === "number" ? e.status : 1 };
	}
}
function relay(r) {
	if (r.out) process.stdout.write(r.out);
	if (r.err) process.stderr.write(r.err);
	process.exit(r.code);
}`;

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

/** Slack on top of a budget before a bound is considered breached. */
const SLACK_MS = 3_000;

function elapsedSince(started: bigint): number {
	return Number(process.hrtime.bigint() - started) / 1e6;
}

function assertWithinBudget(started: bigint, budgetMs: number, what: string): void {
	const elapsedMs = elapsedSince(started);
	assert.ok(
		elapsedMs < budgetMs + SLACK_MS,
		`${what} took ${elapsedMs.toFixed(0)}ms — it should give up near its ${budgetMs}ms budget, not hang`,
	);
}

// ---------------------------------------------------------------------------
// 1. A git that never answers.
// ---------------------------------------------------------------------------

test("a hanging git cannot block the worktree probes or a worktree launch", { skip: !hasGit() }, () => {
	const repo = initRepo();
	// Warm the --path-format capability cache against the REAL git first, so the
	// shimmed calls below measure the probe budget and not a capability re-probe.
	assert.equal(isInsideChildWorktree(repo), false, "real git answers before the shim is installed");
	const shim = installGitShim("setTimeout(() => process.exit(0), 30000);");
	try {
		const probeStart = process.hrtime.bigint();
		assert.equal(
			isInsideChildWorktree(repo),
			false,
			"a timed-out git must read as not-in-worktree, never as true",
		);
		assertWithinBudget(probeStart, GIT_PROBE_TIMEOUT_MS, "isInsideChildWorktree");

		const repoStart = process.hrtime.bigint();
		assert.equal(isGitRepo(repo), false, "a timed-out git reports no repo info rather than blocking");
		assertWithinBudget(repoStart, GIT_PROBE_TIMEOUT_MS, "isGitRepo");

		const launchStart = process.hrtime.bigint();
		assert.throws(
			() => createChildWorktree({ repoCwd: repo, runDir: path.join(repo, "run"), name: "w" }),
			(error: unknown) => {
				assert.ok(error instanceof SubagentError, "a timeout surfaces as a SubagentError");
				assert.equal(error.code, ErrorCodes.START_FAILED, "a slow probe is a start failure, not bad params");
				// Wrong-message trap: a timeout is not "this is not a git repository".
				assert.doesNotMatch(error.message, /is not one/, "must not blame the path for a slow git");
				assert.match(error.message, /did not answer|ETIMEDOUT|timed out/i, "message must name the timeout");
				return true;
			},
			"a launch against a hanging git fails instead of hanging forever",
		);
		assertWithinBudget(launchStart, GIT_PROBE_TIMEOUT_MS, "createChildWorktree");
	} finally {
		shim.restore();
		rmSync(repo, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// 2. `worktree add` fails with EMPTY stderr (what a SIGTERM'd child looks like).
// ---------------------------------------------------------------------------

test("a worktree add failure with empty stderr still reports a diagnostic", { skip: !hasGit() }, () => {
	const repo = initRepo();
	const shim = installGitShim(
		`${DELEGATE}
// Silently fail only the mutating subcommand: empty stderr, non-zero exit.
if (args.includes("worktree")) process.exit(1);
relay(run(args));`,
	);
	try {
		assert.throws(
			() =>
				createChildWorktree({
					repoCwd: repo,
					runDir: path.join(repo, "run"),
					name: "w",
				}),
			(error: unknown) => {
				assert.ok(error instanceof SubagentError);
				assert.equal(error.code, ErrorCodes.START_FAILED);
				// Regression guard: with stderr empty the old extraction produced
				// "git worktree add failed: " and dropped the only clue there was.
				assert.match(error.message, /git worktree add failed: \S/, "message must not end after the colon");
				return true;
			},
		);
	} finally {
		shim.restore();
		rmSync(repo, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// 3. git < 2.31: `--path-format` is echoed back as a revision.
// ---------------------------------------------------------------------------

test("an old git that echoes --path-format cannot make a main checkout look like a worktree", {
	skip: !hasGit(),
}, () => {
	const repo = initRepo();
	const sub = path.join(repo, "src", "legion");
	mkdirSync(sub, { recursive: true });
	const real = realGitPath();
	const expected = execFileSync(real, ["-C", repo, "rev-parse", "--path-format=absolute", "--git-dir"], {
		encoding: "utf8",
	}).trim();
	const wt = path.join(mkdtempSync(path.join(tmpdir(), "wt-oldgit-wt-")), "linked");
	execFileSync("git", ["-C", repo, "worktree", "add", "-b", "oldgit-wt", wt], { stdio: "ignore" });
	mkdirSync(path.join(wt, "deep"), { recursive: true });

	const shim = installGitShim(
		`${DELEGATE}
// Emulate git < 2.31: an unknown --path-format=X is treated as a REVISION and
// echoed, then the remaining rev-parse flags are served normally.
const pf = args.find((a) => a.startsWith("--path-format="));
if (!pf) relay(run(args));
const rest = args.filter((a) => a !== pf);
const r = run(rest);
process.stdout.write(pf + "\\n");
if (r.out) process.stdout.write(r.out);
if (r.err) process.stderr.write(r.err);
process.exit(r.code);`,
	);
	try {
		// The shim must actually be the git being exercised.
		const echoed = execFileSync("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-dir"], {
			encoding: "utf8",
		}).trim();
		assert.equal(
			echoed.split("\n")[0],
			"--path-format=absolute",
			"fixture check: the shim echoes the option as a revision like git < 2.31 does",
		);
		assert.notEqual(echoed, expected, "fixture check: the shim really changes rev-parse output");

		// The whole point: a plain checkout must never be reported as a worktree.
		assert.equal(isInsideChildWorktree(repo), false, "old git: main checkout root is not a worktree");
		assert.equal(isInsideChildWorktree(sub), false, "old git: main checkout subdirectory is not a worktree");
		assert.equal(isInsideChildWorktree(wt), true, "old git: a linked worktree is still detected");
		assert.equal(
			isInsideChildWorktree(path.join(wt, "deep")),
			true,
			"old git: a linked worktree subdirectory is still detected",
		);
	} finally {
		shim.restore();
		execFileSync("git", ["-C", repo, "worktree", "remove", "--force", wt], { stdio: "ignore" });
		rmSync(path.dirname(wt), { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// 4. The pre-2.31 fallback, exercised directly.
// ---------------------------------------------------------------------------

/**
 * The fallback is only reachable on git < 2.31, so it is pinned here against
 * the same real fixtures. It must answer exactly like the modern path —
 * otherwise an old-git user silently loses (or wrongly gains) worktree
 * isolation, and the subdirectory case is the whole point of this branch.
 *
 * Resolve-both-against-cwd is not sufficient on its own: the naive compare is
 * `true` for every case below, and `path.resolve(symlinkedCwd, relative) `
 * lands OUTSIDE the repo, so this pins the realpath anchor too.
 */
test("the legacy two-call fallback preserves the root/subdirectory answers", { skip: !hasGit() }, () => {
	const repo = initRepo();
	const wt = path.join(mkdtempSync(path.join(tmpdir(), "wt-legacy-wt-")), "linked");
	const linkParent = mkdtempSync(path.join(tmpdir(), "wt-legacy-link-"));
	const link = path.join(linkParent, "via-link");
	try {
		mkdirSync(path.join(repo, "a", "b"), { recursive: true });
		execFileSync("git", ["-C", repo, "worktree", "add", "-b", "legacy-wt", wt], { stdio: "ignore" });
		mkdirSync(path.join(wt, "a", "b"), { recursive: true });
		symlinkSync(repo, link);

		for (const cwd of [repo, path.join(repo, "a"), path.join(repo, "a", "b")]) {
			assert.equal(probeLegacyGitDirs(cwd), false, `legacy: plain checkout is not a worktree (${cwd})`);
			assert.equal(
				probeLegacyGitDirs(cwd),
				isInsideChildWorktree(cwd),
				`legacy and modern paths must agree for ${cwd}`,
			);
		}
		for (const cwd of [wt, path.join(wt, "a"), path.join(wt, "a", "b")]) {
			assert.equal(probeLegacyGitDirs(cwd), true, `legacy: linked worktree is detected (${cwd})`);
			assert.equal(
				probeLegacyGitDirs(cwd),
				isInsideChildWorktree(cwd),
				`legacy and modern paths must agree for ${cwd}`,
			);
		}
		// Symlinked cwd: git anchors its output at the symlink target, so the
		// fallback must realpath before resolving or it lands outside the repo.
		assert.equal(
			probeLegacyGitDirs(path.join(link, "a", "b")),
			false,
			"legacy: a symlinked subdirectory of a plain checkout is not a worktree",
		);
	} finally {
		execFileSync("git", ["-C", repo, "worktree", "remove", "--force", wt], { stdio: "ignore" });
		rmSync(path.dirname(wt), { recursive: true, force: true });
		rmSync(linkParent, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// 5. Wiring: every git exec is bounded, on the budget its comment justifies.
// ---------------------------------------------------------------------------

/** Balanced `execFileSync(...)` call text for every occurrence in the source. */
function execCallSites(source: string): string[] {
	const sites: string[] = [];
	const needle = "execFileSync(";
	let from = 0;
	for (;;) {
		const start = source.indexOf(needle, from);
		if (start === -1) break;
		let depth = 0;
		let inString: string | null = null;
		let i = start + needle.length - 1;
		for (; i < source.length; i += 1) {
			const ch = source[i]!;
			if (inString) {
				if (ch === "\\") i += 1;
				else if (ch === inString) inString = null;
				continue;
			}
			if (ch === "\"" || ch === "'" || ch === "`") inString = ch;
			else if (ch === "(") depth += 1;
			else if (ch === ")") {
				depth -= 1;
				if (depth === 0) {
					i += 1;
					break;
				}
			}
		}
		sites.push(source.slice(start, i));
		from = i;
	}
	return sites;
}

function gitCallSites(): string[] {
	return execCallSites(readFileSync(MODULE_PATH, "utf8")).filter((site) => site.includes("\"git\""));
}

test("every git exec in worktree.ts carries a timeout", () => {
	const sites = gitCallSites();
	// path-format probe, the legacy pair (2), the --is-inside-work-tree probe,
	// worktree add, worktree remove. A new git call site must come with a budget.
	assert.equal(
		sites.length,
		5,
		`expected the 5 git execs (3 git-dir probes, 1 --is-inside-work-tree probe, worktree add, worktree remove); found ${sites.length}`,
	);
	for (const site of sites) {
		assert.match(
			site,
			/timeout:\s*GIT_(PROBE|WORKTREE)_TIMEOUT_MS/,
			`unbounded git exec — a hung path would block the parent event loop:\n${site}`,
		);
	}
});

test("the probe budget stays on the fast probes and the bigger one on worktree add/remove", () => {
	const sites = gitCallSites();
	const mutating = sites.filter((site) => /"worktree",\s*"(add|remove)"/.test(site));
	const probing = sites.filter((site) => !mutating.includes(site));
	assert.equal(mutating.length, 2, "worktree add + worktree remove are the mutating sites");
	assert.equal(
		probing.length,
		3,
		"the fast sites are the path-format probe, the legacy pair, and --is-inside-work-tree",
	);
	for (const site of probing) {
		assert.match(site, /rev-parse/, `every probe site runs rev-parse:\n${site}`);
	}
	for (const site of mutating) {
		assert.match(
			site,
			/timeout:\s*GIT_WORKTREE_TIMEOUT_MS/,
			`worktree add/remove needs the bigger budget:\n${site}`,
		);
	}
	for (const site of probing) {
		assert.match(
			site,
			/timeout:\s*GIT_PROBE_TIMEOUT_MS/,
			`rev-parse must not borrow the worktree budget:\n${site}`,
		);
	}
	assert.ok(
		GIT_WORKTREE_TIMEOUT_MS > GIT_PROBE_TIMEOUT_MS,
		`worktree add/remove (${GIT_WORKTREE_TIMEOUT_MS}ms) must exceed the probe budget (${GIT_PROBE_TIMEOUT_MS}ms)`,
	);
});

/**
 * `git rev-parse` is a metadata read; a healthy local repo must never come
 * close to the budget. If this starts failing the budget is being charged to
 * something that is not a plumbing probe (e.g. a network path).
 */
test("a healthy rev-parse probe stays well inside GIT_PROBE_TIMEOUT_MS", { skip: !hasGit() }, () => {
	const repo = initRepo();
	try {
		mkdirSync(path.join(repo, "sub"), { recursive: true });
		for (const cwd of [repo, path.join(repo, "sub")]) {
			const started = process.hrtime.bigint();
			assert.equal(isInsideChildWorktree(cwd), false, `probe succeeds for ${cwd}`);
			const elapsedMs = elapsedSince(started);
			assert.ok(
				elapsedMs < GIT_PROBE_TIMEOUT_MS / 10,
				`rev-parse probe took ${elapsedMs.toFixed(1)}ms — nowhere near the ${GIT_PROBE_TIMEOUT_MS}ms budget`,
			);
		}
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
