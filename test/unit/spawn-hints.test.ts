import assert from "node:assert/strict";
import { test } from "node:test";
import {
	clearSpawnFailures,
	looksLikeMissingModel,
	recentSpawnFailures,
	spawnFailureHint,
	withSpawnFailureHint,
} from "../../src/extension/spawn-hints.ts";

test("looksLikeMissingModel detects pi's model errors", () => {
	assert.equal(looksLikeMissingModel('Error: Model "workbuddy/x:high" not found. Use --list-models'), true);
	assert.equal(looksLikeMissingModel("No models available. Use /login"), true);
	assert.equal(looksLikeMissingModel("ENOENT: no such file"), false);
});

test("spawnFailureHint mentions --no-extensions and doctor when model missing", () => {
	const hint = spawnFailureHint({
		stderr: 'Error: Model "workbuddy/hy4:high" not found. Use --list-models',
		args: ["--mode", "rpc", "--no-extensions", "--model", "workbuddy/hy4:high"],
	});
	assert.ok(hint);
	assert.match(hint!, /--no-extensions/);
	assert.match(hint!, /PI_LEGION_CHILD_EXTENSIONS|inheritExtensions/);
	assert.match(hint!, /\/legion doctor|action=diagnose/);
});

test("withSpawnFailureHint records failures for doctor", () => {
	clearSpawnFailures();
	const msg = withSpawnFailureHint("Pi RPC process exited during startup: Model \"x\" not found", {
		name: "scout-0",
		stderr: 'Error: Model "x" not found. Use --list-models',
		args: ["--no-extensions"],
	});
	assert.match(msg, /Hint:/);
	const recent = recentSpawnFailures();
	assert.equal(recent.length, 1);
	assert.equal(recent[0]!.name, "scout-0");
	assert.equal(recent[0]!.hadNoExtensions, true);
	clearSpawnFailures();
});
