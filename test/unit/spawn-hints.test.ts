import assert from "node:assert/strict";
import { test } from "node:test";
import {
	INPROCESS_MODEL_HINT,
	appendInprocessModelHint,
	clearSpawnFailures,
	looksLikeMissingModel,
	recentSpawnFailures,
	spawnFailureHint,
	withSpawnFailureHint,
} from "../../src/extension/spawn-hints.ts";
import {
	CREDENTIAL_FIX_ADVICE,
	INPROCESS_CREDENTIAL_FAILURE,
	INPROCESS_MODEL_FAILURE,
	MODEL_MISS_ADVICE,
} from "../helpers/inprocess-failure.ts";

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
	assert.match(hint!, /PI_LEGION_CHILD_EXTENSIONS/);
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

test("appendInprocessModelHint: pure gate, appended once, byte-identical otherwise", () => {
	const message = INPROCESS_MODEL_FAILURE;
	const hinted = appendInprocessModelHint(message);
	assert.ok(hinted.startsWith(`${message}\n\nHint: `), "the original message survives verbatim as the prefix");
	assert.match(hinted, /models\.json/);
	// One hint per call — the gate is the marker, so "no double hint" is the call
	// sites' job (each appends once per failure), not an accumulating series.
	assert.equal((hinted.match(/Hint:/g) ?? []).length, 1);

	// An rpc-shaped message never carries the in-process marker, so no second
	// hint can be glued under one that already has a section of its own.
	const rpc = 'Pi RPC process exited during startup: Error: Model "x" not found\n\nHint: argv advice';
	assert.equal(appendInprocessModelHint(rpc), rpc);
	// A plain failure is returned untouched (the frozen `teams.test.ts` wording).
	const plain = "spawn refused for the interrupt test";
	assert.equal(appendInprocessModelHint(plain), plain);

	// The gate is case-insensitive, like `MODEL_NOT_FOUND`.
	assert.match(appendInprocessModelHint("INPROCESS MODEL RESOLVE FAILED for 'x'"), /Hint: /);
});

// ── R7: a credential failure is not a model miss ─────────────────────────────
//
// `spawnFailureHint` only knows the model-miss wording, so an in-process child
// rejected for `No API key found for "x"` reached the caller with NO hint at
// all. Worse, `inprocess model resolve failed … No matching provider is
// authenticated.` (the SDK's ambiguous-provider branch) matched the model gate
// and got advice to edit `models.json` / add an extension — while the only
// repair that works is `/login`.

test("R7: a missing API key is diagnosed as authentication, not as a model miss", () => {
	const hinted = appendInprocessModelHint(INPROCESS_CREDENTIAL_FAILURE);
	assert.ok(
		hinted.startsWith(INPROCESS_CREDENTIAL_FAILURE),
		"the original failure survives verbatim as the prefix",
	);
	assert.match(hinted, CREDENTIAL_FIX_ADVICE, "the fix that actually creates the credential");
	assert.doesNotMatch(hinted, MODEL_MISS_ADVICE, "editing models.json cannot create a credential");
	assert.doesNotMatch(hinted, /PI_LEGION_CHILD_EXTENSIONS/);
	assert.equal((hinted.match(/Hint:/g) ?? []).length, 1);
});

test("R7: an ambiguous-provider resolve failure routes to the credential hint, not the model hint", () => {
	// The message contains BOTH the in-process resolve marker AND a credential
	// root cause. The root cause wins: the model hint would teach the wrong repair.
	const message = "inprocess model resolve failed for 'p/m': No matching provider is authenticated.";
	const hinted = appendInprocessModelHint(message);
	assert.match(hinted, CREDENTIAL_FIX_ADVICE);
	assert.doesNotMatch(
		hinted,
		MODEL_MISS_ADVICE,
		`a credential problem must not be reported as a declaration problem:\n${hinted}`,
	);
	assert.doesNotMatch(hinted, /inprocess children resolve models via ModelRuntime/);
});

test("R7: a genuine model miss still gets the model hint (regression guard)", () => {
	const hinted = appendInprocessModelHint(INPROCESS_MODEL_FAILURE);
	assert.match(hinted, MODEL_MISS_ADVICE);
	assert.match(hinted, /PI_LEGION_CHILD_EXTENSIONS/);
	assert.doesNotMatch(hinted, CREDENTIAL_FIX_ADVICE, "a model name is not an authentication problem");
});

test("R7: an already-hinted failure is never hinted twice", () => {
	// A credential failure that already carries a hint stays byte-identical…
	const credential = `${INPROCESS_CREDENTIAL_FAILURE}\n\nHint: run \`/login\` first.`;
	assert.equal(appendInprocessModelHint(credential), credential);
	// …and so does one carrying an auto-doctor section, marker or not.
	const doctor = `${INPROCESS_MODEL_FAILURE}\n\n--- Legion auto-doctor ---\nmodels: ghost/model`;
	assert.equal(appendInprocessModelHint(doctor), doctor);
});

test("R7: a hint section that OPENs the message counts too (no leading blank line)", () => {
	// The SDK's rejection is often the whole text, so the `Hint: ` line is the
	// first line — `/^Hint: /` with no preceding `\n\n`. The old `\n\n`-only gate
	// missed it and appended a second `Fix:` block to the same message.
	const opening = "Hint: run `/login workbuddy` and retry.";
	assert.equal(appendInprocessModelHint(opening), opening);
	// A marker + an opening hint is still one section, not two.
	const openingWithMarker = `Hint: run \`/login workbuddy\`\n${INPROCESS_MODEL_FAILURE}`;
	assert.equal(appendInprocessModelHint(openingWithMarker), openingWithMarker);
});
