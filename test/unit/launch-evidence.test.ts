/**
 * #423 — the one rule every surface uses to decide "did this launch prove it started".
 *
 * The issue measured four children in one day that returned success, never
 * started on the target machine, and were then rendered as `working` and counted
 * as stall candidates. Three surfaces had three answers; this module is the one
 * they now share, so the rule itself gets its own tests instead of being
 * re-derived (and re-broken) inside a renderer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	crossMachineHost,
	isUnstartedShell,
	launchEvidence,
	shellReason,
	transcriptBytesOf,
} from "../../src/runs/launch-evidence.ts";

test("#423: a LOCAL child is started by definition — its liveness is a pid on this host", () => {
	for (const host of [undefined, null, "", "   ", "local"]) {
		const evidence = launchEvidence({ host, transcriptBytes: 0 });
		assert.deepEqual(evidence, { started: true, reason: "local" }, `host=${JSON.stringify(host)}`);
		assert.equal(isUnstartedShell({ host, transcriptBytes: 0 }), false);
		assert.equal(shellReason({ host, transcriptBytes: 0 }), undefined);
	}
});

test("#423: a cross-machine child with a terminal address is started even before it writes", () => {
	const evidence = launchEvidence({ host: "hw-nj", remoteTerminal: "hw-nj/lgl-r1-work", transcriptBytes: 0 });
	assert.deepEqual(evidence, { started: true, reason: "terminal" });
	assert.equal(isUnstartedShell({ host: "hw-nj", remoteTerminal: "hw-nj/lgl-r1-work" }), false);
});

test("#423: a cross-machine child with a transcript is started even when the address was never recorded", () => {
	const evidence = launchEvidence({ host: "hw-nj", transcriptBytes: 842 });
	assert.deepEqual(evidence, { started: true, reason: "transcript" });
});

test("#423: no terminal AND no transcript is the shell — the exact state the issue measured", () => {
	const facts = { host: "hw-nj", transcriptBytes: 0 };
	assert.deepEqual(launchEvidence(facts), { started: false, reason: "no-evidence" });
	assert.equal(isUnstartedShell(facts), true);
	assert.equal(shellReason(facts), "no terminal and no session on hw-nj: the launch never proved it started");
	// An absent byte count is the same fact as an empty file: nothing was written.
	assert.equal(isUnstartedShell({ host: "hw-nj" }), true);
	// A blank address is not an address (a core that returns "" never made a terminal).
	assert.equal(isUnstartedShell({ host: "hw-nj", remoteTerminal: "  ", transcriptBytes: 0 }), true);
});

test("#423: `crossMachineHost` treats the display spelling `local` as this host", () => {
	assert.equal(crossMachineHost("hw-nj"), "hw-nj");
	assert.equal(crossMachineHost(" hw-nj "), "hw-nj");
	for (const value of [undefined, null, "", "  ", "local", "LOCAL"]) {
		assert.equal(crossMachineHost(value), undefined);
	}
	assert.equal(crossMachineHost(42 as unknown as string), undefined);
});

test("#423: `transcriptBytesOf` answers 0 for a missing file, a directory and an empty file", () => {
	const root = mkdtempSync(path.join(tmpdir(), "launch-evidence-"));
	try {
		const empty = path.join(root, "empty.jsonl");
		writeFileSync(empty, "");
		const written = path.join(root, "written.jsonl");
		writeFileSync(written, '{"type":"message"}\n');
		assert.equal(transcriptBytesOf(empty), 0);
		assert.equal(transcriptBytesOf(written), 19);
		assert.equal(transcriptBytesOf(path.join(root, "missing.jsonl")), 0);
		assert.equal(transcriptBytesOf(root), 0, "a directory holds no transcript");
		assert.equal(transcriptBytesOf(""), 0);
		assert.equal(transcriptBytesOf(undefined), 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
