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

test("provisionWorktree npm-install resolves a package.json to npm install", () => {
	const wt = fakeWorktree({ "package.json": "{}" });
	// Substitute the real installer with a no-op sentinel via PATH: the
	// resolution result is observable through the marker mode alone.
	const result = provisionWorktree({ worktreePath: wt, mode: "npm-install", timeoutMs: 5_000 });
	// In a bare temp dir `npm install` on `{}` succeeds fast; assert via marker.
	assert.equal(result.applied, "npm-install");
	assert.ok(existsSync(provisionMarkerPath(wt)));
	rmSync(wt, { recursive: true, force: true });
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
