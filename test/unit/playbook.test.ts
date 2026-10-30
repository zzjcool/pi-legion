import { test } from "node:test";
import assert from "node:assert/strict";
import {
	forbiddenDispatchReason,
	PARENT_PLAYBOOK,
	shellChunks,
	TOOL_DESCRIPTION,
} from "../../src/extension/playbook.ts";

test("playbook text describes the backend-neutral launch and frozen child guidance", () => {
	assert.match(PARENT_PLAYBOOK, /subagent\(\{ agent:/);
	assert.match(PARENT_PLAYBOOK, /matching role/);
	assert.match(PARENT_PLAYBOOK, /Forbidden/);
	assert.match(PARENT_PLAYBOOK, /Isolation belongs to centurion/);
	assert.match(PARENT_PLAYBOOK, /worktree: true/);
	// #303: the playbook used to say "For N parallel isolated writers, dispatch N
	// centurions". That was an instruction to nest a centurion inside a centurion,
	// which the runtime REFUSES (only the root may dispatch one) — so it told models
	// to do something that could only fail. It now describes the ownership rule
	// without prescribing a nested dispatch.
	assert.match(PARENT_PLAYBOOK, /owns one worktree/);
	assert.doesNotMatch(PARENT_PLAYBOOK, /dispatch N centurions/);
	// D1: children are in-process by default; a separate `pi` process is the
	// worktree/`spawnMode: rpc` case only.
	assert.match(PARENT_PLAYBOOK, /Children are in-process by default/);
	// The `spawnMode` role field is gone (#290); the playbook must not describe it.
	assert.doesNotMatch(PARENT_PLAYBOOK, /spawnMode/);
	assert.match(PARENT_PLAYBOOK, /may hold one/);
	assert.doesNotMatch(PARENT_PLAYBOOK, /headless RPC children/);
	assert.match(PARENT_PLAYBOOK, /verify:/);
	assert.match(TOOL_DESCRIPTION, /async by default/);
	assert.match(PARENT_PLAYBOOK, /Esc \/ wait interrupt only ends the parent turn/);
	assert.doesNotMatch(PARENT_PLAYBOOK, /Same agent type shares one tab/);
});

test("playbook never narrows a backend-neutral fact to the rpc backend (#209/D1)", () => {
	// D1's whole point: the parent-facing copy must not present the rpc backend
	// as the default transport. This is the whole-string guard the review asked
	// for — it catches a NEW rpc-named sentence, not just the four deleted ones.
	assert.doesNotMatch(
		PARENT_PLAYBOOK + TOOL_DESCRIPTION,
		/headless RPC|via RPC|RPC child|RPC launch/i,
	);
	// `--no-extensions` is not an rpc-only fact: in-process children set
	// `noExtensions = !childInheritsExtensions(...)` too
	// (`inprocess-supervisor.ts:145`), so the sentence must stay backend-neutral.
	assert.doesNotMatch(PARENT_PLAYBOOK, /rpc children use `--no-extensions`/);
	assert.match(PARENT_PLAYBOOK, /without host extensions unless the role inherits them/);
});

test("shellChunks splits compound commands", () => {
	assert.deepEqual(shellChunks('test "$HERDR_ENV" = 1 && herdr --help'), [
		'test "$HERDR_ENV" = 1',
		"herdr --help",
	]);
});

test("parent bash no longer blocks legacy herdr inspection commands", () => {
	for (const command of ["herdr --help", "herdr pane list", "herdr agent start worker"]) {
		assert.equal(forbiddenDispatchReason(command), undefined);
	}
});





test("legacy herdr commands remain available for manual v0.16.x workflows", () => {
	const allowed = [
		"herdr pane list",
		"herdr pane read w1:p1",
		"herdr pane close w1:p2",
		"herdr agent list",
		"herdr agent get worker-0",
		"herdr agent read worker-0",
		"herdr tab list",
		"ls",
		"npm test",
		"echo hello",
	];
	for (const command of allowed) {
		assert.equal(
			forbiddenDispatchReason(command),
			undefined,
			`must allow: ${command}`,
		);
	}
});

test("playbook keeps the explicit wait action available", () => {
	assert.match(PARENT_PLAYBOOK, /Use `wait` with `name` or `all: true` when you need blocking results/);
	assert.match(TOOL_DESCRIPTION, /collect, wait, list, retire/);
});

test("playbook describes event-driven waits and graceful stop", () => {
	assert.match(PARENT_PLAYBOOK, /use `stop` to gracefully retire one child or all tracked children/);
	assert.match(TOOL_DESCRIPTION, /collect, wait, list, retire, stop/);
	assert.match(TOOL_DESCRIPTION, /it is event-driven/);
	assert.match(TOOL_DESCRIPTION, /Esc does not retire children/);
});

test("playbook explains timeout and steering semantics", () => {
	assert.match(PARENT_PLAYBOOK, /collect timeout with a live child is a progress signal/);
	assert.doesNotMatch(PARENT_PLAYBOOK, /live RPC child/);
	assert.match(PARENT_PLAYBOOK, /session JSONL/);
	assert.match(PARENT_PLAYBOOK, /Do not tell a child to message or prompt the parent/);
});

test("playbook documents status overview vs single child (#145)", () => {
	assert.match(PARENT_PLAYBOOK, /`status` with no name/);
	assert.match(PARENT_PLAYBOOK, /`all: true`/);
	assert.match(TOOL_DESCRIPTION, /`status` with no name \(or `all: true`\)/);
	assert.match(TOOL_DESCRIPTION, /with `name` returns that one child/);
});

test("playbook requires name or all for wait (#161)", () => {
	assert.match(TOOL_DESCRIPTION, /`wait` REQUIRES `name` or `all: true`/);
	assert.match(TOOL_DESCRIPTION, /action: "wait", all: true/);
	assert.match(PARENT_PLAYBOOK, /Use `wait` with `name` or `all: true`/);
});

test("playbook says steer queues at a turn boundary and stop is the interrupt (#313)", () => {
	// #313: a `steer` receipt must not read like a delivery claim. `steer` is a
	// queue the child consumes at a turn boundary, so it cannot reach a child
	// that is inside a tool call — writing to stdin of a running bash is not a
	// thing. The playbook has to state the negative semantics, or models keep
	// "steering" a child that is stuck in one long command and never lands.
	assert.match(PARENT_PLAYBOOK, /`steer` is a queue, not an interrupt/);
	assert.match(PARENT_PLAYBOOK, /does not interrupt a tool call that is already executing/);
	assert.match(PARENT_PLAYBOOK, /next turn boundary/);
	assert.match(PARENT_PLAYBOOK, /after the current tool batch finishes/);
	assert.match(PARENT_PLAYBOOK, /never receives a steer/);
	// …and that `stop` is what actually interrupts.
	assert.match(PARENT_PLAYBOOK, /To actually stop a child, use `stop`/);
	assert.match(PARENT_PLAYBOOK, /`force: true` is the hard variant/);
	// TOOL_DESCRIPTION embeds PARENT_PLAYBOOK, so it inherits the paragraph —
	// asserting it here pins the embedding (no second copy to drift).
	assert.match(TOOL_DESCRIPTION, /`steer` is a queue, not an interrupt/);
	assert.match(TOOL_DESCRIPTION, /To actually stop a child, use `stop`/);
	// Numbering stays contiguous and item 8 sits before the unnumbered
	// "Utility agents …" paragraph (D7: append, never renumber items 1-7).
	const item7 = PARENT_PLAYBOOK.indexOf("\n7. ");
	const item8 = PARENT_PLAYBOOK.indexOf("\n8. ");
	const utility = PARENT_PLAYBOOK.indexOf("\nUtility agents");
	assert.ok(item7 > 0, "item 7 must exist");
	assert.ok(item8 > item7, "item 8 must follow item 7");
	assert.ok(utility > item8, "item 8 must precede the Utility agents paragraph");
	// #314 replaced the old `doesNotMatch(/\n9\. /)` pin: that assertion existed
	// to prove the list is CONTIGUOUS, not that it may never grow. Item 9 is the
	// abort paragraph and it belongs between item 8 and the Utility agents
	// paragraph — a new item inserted anywhere else would break the numbering.
	const item9 = PARENT_PLAYBOOK.indexOf("\n9. ");
	assert.ok(item9 > item8, "item 9 must follow item 8");
	assert.ok(item9 < utility, "item 9 must precede the Utility agents paragraph");
	assert.equal(
		PARENT_PLAYBOOK.indexOf("\n10. "),
		-1,
		"the list stops at item 9 — a gap would mean an item was dropped",
	);
});

test("playbook draws the abort-vs-stop boundary and names abort where steer cannot land (#314)", () => {
	// (a) abort keeps the context/session, so the child stays continuable.
	assert.match(PARENT_PLAYBOOK, /`abort` interrupts the child's current turn and keeps its context and session/);
	assert.match(PARENT_PLAYBOOK, /the child stays alive and can be continued/);
	// (b) stop is what tears the process down and throws the context away — the
	// two must not read like the same action.
	assert.match(PARENT_PLAYBOOK, /`stop` is the one that tears the process down and throws the context away/);
	// (c) abort works where steer cannot land: a child stuck inside one long
	// command (#313 — a steer is a queue that only fires at a turn boundary).
	assert.match(PARENT_PLAYBOOK, /works on a child stuck inside one long-running command, where `steer` cannot land/);
	assert.match(PARENT_PLAYBOOK, /#313: a steer only queues at a turn boundary/);
	// Defaults and the "a timeout is not a failure" rule are spelled out, or a
	// model reads a timeout receipt as "it died".
	assert.match(PARENT_PLAYBOOK, /queued steering\/follow-up messages are dropped first/);
	assert.match(PARENT_PLAYBOOK, /`clearQueued: false` keeps them/);
	assert.match(PARENT_PLAYBOOK, /A timeout receipt is not a failure/);
	// TOOL_DESCRIPTION carries the action and the same boundary as one sentence
	// (it embeds PARENT_PLAYBOOK, so this also pins the embedding).
	assert.match(TOOL_DESCRIPTION, /stop, abort, diagnose/);
	assert.match(
		TOOL_DESCRIPTION,
		/`abort` stops the child's current turn but keeps its context and session \(child stays alive and continuable; queued messages are dropped first\); `stop` is the one that takes the process down\./,
	);
	// The rpc-narrowing guard in the test above covers the whole string; keep the
	// new sentences backend-neutral too.
	assert.doesNotMatch(
		PARENT_PLAYBOOK + TOOL_DESCRIPTION,
		/headless RPC|via RPC|RPC child|RPC launch/i,
	);
});
