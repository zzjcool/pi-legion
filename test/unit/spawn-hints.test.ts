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
	assert.equal(looksLikeMissingModel("inprocess model resolve failed for 'x': Unknown provider"), true);
});

test("spawnFailureHint mentions --no-extensions and doctor when model missing (rpc)", () => {
	const hint = spawnFailureHint({
		stderr: 'Error: Model "workbuddy/hy4:high" not found. Use --list-models',
		args: ["--mode", "rpc", "--no-extensions", "--model", "workbuddy/hy4:high"],
		spawnMode: "rpc",
	});
	assert.ok(hint);
	assert.match(hint!, /--no-extensions/);
	assert.match(hint!, /PI_LEGION_CHILD_EXTENSIONS|inheritExtensions/);
	assert.match(hint!, /\/legion doctor|action=diagnose/);
});

test("#212 spawnFailureHint for inprocess avoids argv / PI_LEGION_CHILD_EXTENSIONS", () => {
	const hint = spawnFailureHint({
		stderr: "inprocess model resolve failed for 'workbuddy/hy4': Unknown provider",
		spawnMode: "inprocess",
		// even if a caller accidentally passes rpc-shaped args, spawnMode wins
		args: ["--no-extensions", "--model", "workbuddy/hy4"],
	});
	assert.ok(hint);
	assert.doesNotMatch(hint!, /PI_LEGION_CHILD_EXTENSIONS/);
	assert.doesNotMatch(hint!, /children start with `--no-extensions`/);
	assert.match(hint!, /inprocess/);
	assert.match(hint!, /models\.json/);
	assert.match(hint!, /\/legion doctor|action=diagnose/);
});

test("withSpawnFailureHint records failures for doctor", () => {
	clearSpawnFailures();
	const msg = withSpawnFailureHint("Pi RPC process exited during startup: Model \"x\" not found", {
		name: "scout-0",
		stderr: 'Error: Model "x" not found. Use --list-models',
		args: ["--no-extensions"],
		spawnMode: "rpc",
	});
	assert.match(msg, /Hint:/);
	const recent = recentSpawnFailures();
	assert.equal(recent.length, 1);
	assert.equal(recent[0]!.name, "scout-0");
	assert.equal(recent[0]!.hadNoExtensions, true);
	assert.equal(recent[0]!.spawnMode, "rpc");
	clearSpawnFailures();
});

test("#212 withSpawnFailureHint records inprocess without hadNoExtensions", () => {
	clearSpawnFailures();
	const msg = withSpawnFailureHint("inprocess model resolve failed for 'x'", {
		name: "scout-0",
		stderr: "Unknown provider: x",
		spawnMode: "inprocess",
	});
	assert.match(msg, /Hint:/);
	assert.doesNotMatch(msg, /PI_LEGION_CHILD_EXTENSIONS/);
	const recent = recentSpawnFailures();
	assert.equal(recent[0]!.spawnMode, "inprocess");
	assert.equal(recent[0]!.hadNoExtensions, false);
	clearSpawnFailures();
});
