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
