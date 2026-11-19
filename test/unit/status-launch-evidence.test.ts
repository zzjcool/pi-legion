/**
 * #423 — `subagent status` must not call a shell `working`.
 *
 * The issue's second surface: `state=working` / `state=launching` with `quiet
 * 1057s (living)` next to a 0-byte local transcript, no `remoteTerminal`, and
 * nothing at all on the target machine. Both the state word and the liveness line
 * were unsupported by any fact the renderer had — it printed the record's claim.
 *
 * The rule now comes from `launch-evidence` (one place), so the renderer cannot
 * disagree with the stall detector or with the retire verdict.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { renderLiveChildStatus, type LiveChildStatusInput } from "../../src/extension/runtime.ts";

const HOST = "hw-nj";

function sandbox(): { root: string; empty: string; written: string; cleanup: () => void } {
	const root = mkdtempSync(path.join(tmpdir(), "status-shell-"));
	const empty = path.join(root, "empty.jsonl");
	writeFileSync(empty, "");
	const written = path.join(root, "written.jsonl");
	writeFileSync(written, '{"type":"message","message":{"role":"user","content":"hi"}}\n');
	return { root, empty, written, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function input(overrides: Partial<LiveChildStatusInput>): LiveChildStatusInput {
	return {
		name: "legion-408",
		state: "working",
		agent: "centurion",
		kind: "pi",
		sessionFile: "/nonexistent/session.jsonl",
		alive: true,
		...overrides,
	};
}

test("#423 req 4: a cross-machine child with no terminal and no transcript renders `unknown`, not `working`", () => {
	const box = sandbox();
	try {
		const text = renderLiveChildStatus(input({ host: HOST, sessionFile: box.empty, alive: true }));
		assert.match(text, /^legion-408 — state=unknown /m, `the state word must not claim work:\n${text}`);
		assert.match(text, /^liveness=unknown \(no terminal and no session on hw-nj: the launch never proved it started\)$/m);
		// The two lines that used to make a shell look busy.
		assert.doesNotMatch(text, /quiet \d+s \(living\)/);
		assert.doesNotMatch(text, /state=working/);
	} finally {
		box.cleanup();
	}
});

test("#423 req 4: a missing transcript file is the same shell as an empty one", () => {
	const box = sandbox();
	try {
		const text = renderLiveChildStatus(input({ host: HOST, sessionFile: path.join(box.root, "absent.jsonl") }));
		assert.match(text, /state=unknown/);
		assert.match(text, /liveness=unknown \(no terminal and no session on hw-nj/);
	} finally {
		box.cleanup();
	}
});

test("#423 req 4: a live remote child WITH a terminal address keeps `working` and its quiet line", () => {
	const box = sandbox();
	try {
		const text = renderLiveChildStatus(input({ host: HOST, remoteTerminal: `${HOST}/lgl-rx-worker-0`, sessionFile: box.empty }));
		assert.match(text, /state=working/, `a child the core holds is work in progress:\n${text}`);
		assert.match(text, /quiet /);
		assert.match(text, new RegExp(`^terminal=${HOST}/lgl-rx-worker-0$`, "m"));
		assert.doesNotMatch(text, /liveness=unknown/);
	} finally {
		box.cleanup();
	}
});

test("#423 req 4: a remote child that wrote a transcript keeps `working` — the rule is about evidence, not about hosts", () => {
	const box = sandbox();
	try {
		const text = renderLiveChildStatus(input({ host: HOST, sessionFile: box.written }));
		assert.match(text, /state=working/);
		assert.doesNotMatch(text, /liveness=unknown/);
	} finally {
		box.cleanup();
	}
});

test("#423 req 4: a LOCAL child is untouched — no host, no shell rule", () => {
	const box = sandbox();
	try {
		const text = renderLiveChildStatus(input({ sessionFile: box.empty }));
		assert.match(text, /state=working/);
		assert.match(text, /^host=local$/m);
		assert.match(text, /^terminal=-$/m);
		assert.doesNotMatch(text, /liveness=unknown/);
	} finally {
		box.cleanup();
	}
});
