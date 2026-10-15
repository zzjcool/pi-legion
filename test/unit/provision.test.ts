import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	provisionWorktree,
	provisionMarkerPath,
	PROVISION_MARKER,
} from "../../src/runs/provision.ts";
import { SubagentError } from "../../src/shared/types.ts";

function freshDir(): string {
	return mkdtempSync(path.join(tmpdir(), "prov-"));
}

/** A fake "worktree": provisioning only needs the directory to exist. */
function fakeWorktree(files: Record<string, string> = {}): string {
	const dir = freshDir();
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(path.join(dir, name), content);
	}
	return dir;
}

test("provisionWorktree is a no-op without a mode", () => {
	const wt = fakeWorktree();
	const result = provisionWorktree({ worktreePath: wt });
	assert.equal(result.applied, "skip");
	assert.equal(existsSync(provisionMarkerPath(wt)), false);
	rmSync(wt, { recursive: true, force: true });
});

test("provisionWorktree runs a custom shell command and records the marker", () => {
	const wt = fakeWorktree();
	const result = provisionWorktree({
		worktreePath: wt,
		mode: `printf provisioned > marker.txt`,
	});
	assert.equal(result.applied, "printf provisioned > marker.txt");
	assert.equal(readFileSync(path.join(wt, "marker.txt"), "utf8"), "provisioned");
	const marker = JSON.parse(readFileSync(provisionMarkerPath(wt), "utf8")) as { mode: string };
	assert.equal(marker.mode, "printf provisioned > marker.txt");
	rmSync(wt, { recursive: true, force: true });
});

test("provisionWorktree is idempotent for the same mode and re-runs when the declared mode changes", () => {
	const wt = fakeWorktree();
	provisionWorktree({ worktreePath: wt, mode: `printf one > marker.txt` });
	// Same mode again (the resume path): the marker skips it — this is the
	// invariant that stops every relaunch from re-installing dependencies.
	const second = provisionWorktree({ worktreePath: wt, mode: `printf one > marker.txt` });
	assert.equal(second.applied, "skip");
	assert.equal(readFileSync(path.join(wt, "marker.txt"), "utf8"), "one");
	// A CHANGED declaration is a changed requirement: it re-runs. Otherwise a
	// settings edit would silently keep the old environment forever.
	const third = provisionWorktree({ worktreePath: wt, mode: `printf two > marker.txt` });
	assert.equal(third.applied, "printf two > marker.txt");
	assert.equal(readFileSync(path.join(wt, "marker.txt"), "utf8"), "two");
	rmSync(wt, { recursive: true, force: true });
});

test("provisionWorktree npm-install skips a stray package.json without a lockfile", () => {
	// Java/Maven repos carry stray package.json files for docs/tooling.
	// Without a lockfile the npm-install mode must not fire npm install
	// into a non-npm checkout — it records the marker and moves on.
	const wt = fakeWorktree({ "package.json": "{\"name\":\"maven-repo-docs\"}" });
	const result = provisionWorktree({ worktreePath: wt, mode: "npm-install" });
	assert.equal(result.applied, "npm-install");
	assert.ok(existsSync(provisionMarkerPath(wt)));
	rmSync(wt, { recursive: true, force: true });
});

test("provisionWorktree npm-install resolves a package-lock.json to npm ci", () => {
	const wt = fakeWorktree({
		"package.json": "{}",
		"package-lock.json": "{\"lockfileVersion\":3}",
	});
	const previous = process.env.npm_config_prefix;
	// npm scripts export this. A login bash that sources nvm aborts when it
	// is set, so provisioning must not forward it.
	process.env.npm_config_prefix = "/";
	try {
		const result = provisionWorktree({ worktreePath: wt, mode: "npm-install", timeoutMs: 15_000 });
		assert.equal(result.applied, "npm-install");
		assert.ok(existsSync(provisionMarkerPath(wt)));
		// npm ci with a stub lockfile has no deps to install; assert it did
		// not fail the launch.
	} finally {
		if (previous === undefined) delete process.env.npm_config_prefix;
		else process.env.npm_config_prefix = previous;
		rmSync(wt, { recursive: true, force: true });
	}
});

test("provisionWorktree npm-install without any manifest writes the marker without failing", () => {
	const wt = fakeWorktree();
	const result = provisionWorktree({ worktreePath: wt, mode: "npm-install" });
	assert.equal(result.applied, "npm-install");
	assert.ok(existsSync(provisionMarkerPath(wt)));
	rmSync(wt, { recursive: true, force: true });
});

test("provisionWorktree failure throws SubagentError and leaves no marker", () => {
	const wt = fakeWorktree();
	assert.throws(
		() => provisionWorktree({ worktreePath: wt, mode: "exit 3", timeoutMs: 5_000 }),
		(error: unknown) => {
			assert.ok(error instanceof SubagentError);
			assert.match((error as SubagentError).message, /worktree bootstrap failed/);
			return true;
		},
	);
	assert.equal(existsSync(provisionMarkerPath(wt)), false, "no marker on failure");
	rmSync(wt, { recursive: true, force: true });
});

test("PROVISION_MARKER lives at the worktree root", () => {
	const wt = fakeWorktree();
	assert.equal(provisionMarkerPath(wt), path.join(wt, PROVISION_MARKER));
	rmSync(wt, { recursive: true, force: true });
});
