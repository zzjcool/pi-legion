import assert from "node:assert/strict";
import { test } from "node:test";
import {
	INPROCESS_MODEL_HINT,
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

test("#212 spawnFailureHint for inprocess never gives argv advice (#317: the env path IS honored)", () => {
	const hint = spawnFailureHint({
		stderr: "inprocess model resolve failed for 'workbuddy/hy4': Unknown provider",
		spawnMode: "inprocess",
		// even if a caller accidentally passes rpc-shaped args, spawnMode wins
		args: ["--no-extensions", "--model", "workbuddy/hy4"],
		discoveryStatus: "ok",
	});
	assert.ok(hint);
	// In-process children have no argv, so argv-shaped advice is still wrong...
	assert.doesNotMatch(hint!, /children start with `--no-extensions`/);
	assert.match(hint!, /inprocess/);
	// ...but `PI_LEGION_CHILD_EXTENSIONS` is NOT argv: `collectChildExtensions`
	// reads it for the in-process loader too, so #317 recommends it explicitly.
	assert.match(hint!, /PI_LEGION_CHILD_EXTENSIONS=<path>/);
	assert.match(hint!, /models\.json/);
	assert.match(hint!, /\/legion doctor|action=diagnose/);
});

// ── #317: spawn hints stop recommending levers that no longer do anything ──

test("#317: the inprocess hint names only levers that still change the child's extensions", () => {
	// `inheritExtensions: true` is the default policy (#280) and
	// `PI_LEGION_CHILD_INHERIT_EXTENSIONS=1` is a no-op — recommending either sent
	// operators chasing a switch that changes nothing, and neither brings back a
	// host extension when discovery failed.
	assert.doesNotMatch(INPROCESS_MODEL_HINT, /inheritExtensions/);
	assert.doesNotMatch(INPROCESS_MODEL_HINT, /PI_LEGION_CHILD_INHERIT_EXTENSIONS=1/);
	assert.match(INPROCESS_MODEL_HINT, /PI_LEGION_CHILD_EXTENSIONS=<path>/);
	assert.match(INPROCESS_MODEL_HINT, /models\.json/);
	assert.match(INPROCESS_MODEL_HINT, /\/legion doctor|action=diagnose/);
});

test("#317: the hint says so when inheritance is on but discovery produced nothing", () => {
	const base = { stderr: "Unknown provider: workbuddy/hy4", spawnMode: "inprocess" as const };

	const failed = spawnFailureHint({ ...base, discoveryStatus: "failed" });
	assert.ok(failed);
	assert.match(failed!, /inheritance is enabled but host discovery is failed/);
	assert.match(failed!, /the child got 0 host extensions/);

	const never = spawnFailureHint({ ...base, discoveryStatus: "unknown" });
	assert.ok(never);
	assert.match(never!, /inheritance is enabled but host discovery is never probed/);

	// `ok` means the host's set is known — with 0 entries that is a real empty
	// host, not a broken probe, so no note is appended.
	const ok = spawnFailureHint({ ...base, discoveryStatus: "ok" });
	assert.ok(ok);
	assert.doesNotMatch(ok!, /the child got 0 host extensions/);

	// The rpc-shaped hint carries the same note: an rpc child inherits nothing
	// either when discovery failed.
	const rpc = spawnFailureHint({
		stderr: 'Error: Model "workbuddy/hy4:high" not found. Use --list-models',
		args: ["--no-extensions"],
		spawnMode: "rpc",
		discoveryStatus: "failed",
	});
	assert.ok(rpc);
	assert.match(rpc!, /host discovery is failed/);
	assert.equal(withSpawnFailureHint("boom", { ...base, discoveryStatus: "failed" }).includes("host discovery is failed"), true);
	clearSpawnFailures();
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
		// Pin the discovery state so this case tests the recording shape, not
		// whatever this process happened to probe (#317).
		discoveryStatus: "ok",
	});
	assert.match(msg, /Hint:/);
	// #317: the in-process hint now names the env path (honored by the in-process
	// loader too); what it must never do is hand out argv-shaped advice.
	assert.doesNotMatch(msg, /children start with `--no-extensions`/);
	const recent = recentSpawnFailures();
	assert.equal(recent[0]!.spawnMode, "inprocess");
	assert.equal(recent[0]!.hadNoExtensions, false);
	clearSpawnFailures();
});

test("#317: no spawn hint recommends the dead inheritExtensions switch (rpc branch too)", () => {
	// The rpc branch used to end with "or set `inheritExtensions: true` /
	// `PI_LEGION_CHILD_INHERIT_EXTENSIONS=1` (costs more memory)". That advice is
	// dead (`true` is the default since #280) and now also self-contradictory: the
	// discovery note appended right below says inheritance IS enabled and the child
	// still got 0 host extensions (#317 review, minor 1).
	const rpc = spawnFailureHint({
		stderr: 'Error: Model "workbuddy/hy4:high" not found. Use --list-models',
		args: ["--no-extensions", "--model", "workbuddy/hy4:high"],
		spawnMode: "rpc",
		discoveryStatus: "ok",
	});
	assert.ok(rpc);
	assert.doesNotMatch(rpc!, /inheritExtensions/);
	assert.doesNotMatch(rpc!, /PI_LEGION_CHILD_INHERIT_EXTENSIONS=1/);
	assert.match(rpc!, /PI_LEGION_CHILD_EXTENSIONS/, "the lever that still works stays in the first sentence");
	assert.match(rpc!, /\/legion doctor|action=diagnose/);
});
