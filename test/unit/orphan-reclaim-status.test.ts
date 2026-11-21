/**
 * #456 — an orphaned row must say what the reclaim inspection concluded.
 *
 * Before this, a row the exit left `orphaned` printed `state=orphaned` beside path
 * facts and nothing else, so a child whose terminal was gone AND whose work was
 * done read exactly like a child still running over there — the one distinction
 * `status` exists to make.
 *
 * The verdict is a display suffix on the frozen state word: `stale` / `ownerDead` /
 * shell still decide what `state` says, and a caller that inspected nothing renders
 * the pre-#456 block byte for byte. (The `/legion status` recoverable block is
 * ledger-only and synchronous; it keeps its frozen `orphaned` word rather than
 * advertising a verdict no production caller can supply.)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	orphanVerdictWord,
	renderLiveChildStatus,
	type LiveChildStatusInput,
} from "../../src/extension/runtime.ts";
import type { OrphanReclaimVerdict } from "../../src/shared/types.ts";

const HOST = "njbox";
const TERMINAL = `${HOST}/t2`;
const NOW = 1_000_000;
const SESSION = "/tmp/pi-legion-452-fixture/w.jsonl";

/**
 * Every verdict and the one word it is allowed to render.
 *
 * `Record<OrphanReclaimVerdict, string>` is the exhaustiveness check: a new verdict
 * fails this file to compile until it has a word, so no verdict can render blank.
 */
const VERDICT_WORDS: Record<OrphanReclaimVerdict, string> = {
	"terminal-gone": "terminal gone, work done",
	"stale-orphan": "idle, transcript quiet",
	working: "still working",
	unknown: "liveness unknown",
};

/**
 * The pre-#456 rendering of {@link deadOrphanInput}, copied out of the renderer as
 * it stood before #456: it is the contract that "no inspection ⇒ no change" holds.
 */
const PRE_452_BLOCK = [
	"worker-0 — state=orphaned agent=? kind=?",
	"owner: dead (pid gone)",
	`host=${HOST}`,
	`terminal=${TERMINAL}`,
	"execution: running",
	"acceptance: pending (L2)",
	"context: ctx=0 tok",
	"supervisor=unknown",
	`session=${SESSION}`,
].join("\n");

/** A dead cross-machine orphan: the shape #456 exists for. */
function deadOrphanInput(): LiveChildStatusInput {
	return {
		name: "worker-0",
		state: "orphaned",
		sessionFile: SESSION,
		alive: false,
		owner: "dead",
		host: HOST,
		remoteTerminal: TERMINAL,
		execution: { status: "running" },
		acceptance: { status: "pending", level: "L2" },
		contextTokens: 0,
		now: NOW,
	};
}

/** A ledger row `renderRecoverableSection` will list (it needs a `host`). */

// ── the status block ────────────────────────────────────────────────────────

test("#456: an orphaned row prints the verdict word after its state, evidence underneath", () => {
	const evidence = `terminal '${TERMINAL}' is finished on '${HOST}'`;
	const text = renderLiveChildStatus({
		name: "worker-0",
		state: "orphaned",
		sessionFile: "/tmp/w.jsonl",
		alive: false,
		host: HOST,
		remoteTerminal: TERMINAL,
		orphan: { verdict: "terminal-gone", evidence },
	});
	const lines = text.split("\n");
	assert.ok(
		text.includes("worker-0 — state=orphaned (terminal gone, work done)"),
		"the frozen state word carries the verdict, it is not replaced",
	);
	assert.equal(lines[0], "worker-0 — state=orphaned (terminal gone, work done) agent=? kind=?");
	assert.ok(text.includes(`orphan: ${evidence}`), "the evidence is rendered verbatim");
	assert.equal(lines[1], `orphan: ${evidence}`, "the evidence sits directly under the header");
	assert.ok(!text.includes("state=working"), "an orphan is not working");
});

test("#456: the other three verdict words render exactly, and no evidence means no line", () => {
	const others = [
		["stale-orphan", "idle, transcript quiet"],
		["working", "still working"],
		["unknown", "liveness unknown"],
	] as const satisfies readonly (readonly [OrphanReclaimVerdict, string])[];
	for (const [verdict, word] of others) {
		const text = renderLiveChildStatus({ ...deadOrphanInput(), orphan: { verdict } });
		assert.match(
			text,
			new RegExp(`^worker-0 — state=orphaned \\(${word}\\) agent=\\? kind=\\?$`, "m"),
			`verdict ${verdict} renders its word`,
		);
		assert.doesNotMatch(text, /^orphan:/m, "no evidence, no line");
		assert.ok(!text.includes("state=working"), `verdict ${verdict} must not rewrite the state word`);
	}
});

test("#456: orphanVerdictWord maps all four verdicts", () => {
	for (const verdict of Object.keys(VERDICT_WORDS) as OrphanReclaimVerdict[]) {
		assert.equal(orphanVerdictWord(verdict), VERDICT_WORDS[verdict]);
	}
	assert.equal(Object.keys(VERDICT_WORDS).length, 4, "the verdict union has exactly four members");
});

test("#456: without orphan facts the block is byte identical to the pre-#456 rendering", () => {
	const plain = renderLiveChildStatus(deadOrphanInput());
	assert.equal(plain, PRE_452_BLOCK);
	// The two shapes this change could leak into: a parenthetical after the state word
	// (which the pin above also catches) and an `orphan:` line (which it cannot, if a
	// future caller passes empty evidence).
	assert.doesNotMatch(plain, /state=[a-z]+ \(/);
	assert.doesNotMatch(plain, /^orphan:/m);
	assert.equal(renderLiveChildStatus({ ...deadOrphanInput(), orphan: undefined }), PRE_452_BLOCK);
	// Empty evidence is "no evidence": the header stays decorated, the line is not invented.
	const noEvidence = renderLiveChildStatus({ ...deadOrphanInput(), orphan: { verdict: "unknown", evidence: "  " } });
	assert.match(noEvidence, /^worker-0 — state=orphaned \(liveness unknown\) /m);
	assert.doesNotMatch(noEvidence, /^orphan:/m);
});

test("#456: a status=orphaned block never contains state=working", () => {
	for (const verdict of Object.keys(VERDICT_WORDS) as OrphanReclaimVerdict[]) {
		const text = renderLiveChildStatus({ ...deadOrphanInput(), orphan: { verdict, evidence: "checked" } });
		assert.ok(!text.includes("state=working"), `verdict ${verdict} must not print state=working`);
		assert.match(text, /^worker-0 — state=orphaned \(/m, "the record's state word survives the decoration");
	}
});
