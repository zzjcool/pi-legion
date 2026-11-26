/**
 * `demo-findings-v1` — four defects a live demo surfaced, all in what the model READS.
 *
 * One case per finding, each pinned in both directions where the finding is a
 * branch (D1 banner, D2 interrupted turn, D4 log path):
 *
 *   - F1/D1: `accepted (verified)` must not sit next to "these gate the verdict".
 *     The banner follows `AcceptanceResult.status`, not the presence of a required
 *     pending criterion (`pendingCriteria` never influenced `status`).
 *   - F2/D2: an interrupted turn (`execution.status !== "completed"`) keeps its
 *     verify — but its verdict can never be `rejected` about work nobody measured.
 *   - F3/D3: `verification: STALE` and the stale nudge each say WHEN to commit
 *     (before entering verifying). The render line lives in `index.ts`; the nudge
 *     is pinned where it is actually sent (`legion-done-gate-order.test.ts`).
 *   - F4/D4: `SessionErrorSummary.logPath` is only handed out when the file exists,
 *     and doctor says "in-memory only" instead of naming a dead path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { renderCollect } from "../../index.ts";
import { applyVerification } from "../../src/runs/acceptance.ts";
import {
	SESSION_ERRORS_FILE,
	clearSessionErrors,
	configureSessionErrors,
	recordSessionError,
	summarizeSessionErrors,
} from "../../src/extension/session-errors.ts";
import { runLegionDoctor } from "../../src/extension/legion-doctor.ts";
import type { AcceptanceResult } from "../../src/shared/types.ts";
import type { CollectSnapshot } from "../../src/extension/runtime.ts";

initTheme("dark");

// ---------------------------------------------------------------------------
// F1 / D1 — the banner follows the settled status, never the pending list
// ---------------------------------------------------------------------------

/** A finished result whose acceptance carries criteria only a human/model can judge. */
function snapshot(
	status: string,
	criteria: Array<{ id: string; must: string; severity?: string }>,
): CollectSnapshot {
	return {
		execution: { status: "success" },
		output: "the answer",
		acceptance: { status, level: "attested", pendingCriteria: criteria },
	};
}

const REQUIRED = [{ id: "typecheck-test-pass", must: "npm run typecheck passes" }];
const OPTIONAL_ONLY = [{ id: "nice-names", must: "tidy the identifiers", severity: "optional" }];
const GATING_BANNER = /^unverified criteria — these gate the verdict:$/m;
const SETTLED_BANNER = /^unverified criteria — the verdict is already settled; confirm them from the pasted output:$/m;
const OPTIONAL_BANNER = /^optional criteria — fix them if cheap, but they do not gate the verdict:$/m;

test("D1: an accepted verdict never claims its pending criteria gate the verdict", () => {
	// The demo's exact shape: `accepted (verified)` from `applyVerification` plus a
	// required criterion that carries no `command`, so nothing ran it.
	const rendered = renderCollect("a", snapshot("accepted", REQUIRED), undefined, undefined);
	assert.match(rendered, /^acceptance: accepted/m);
	assert.match(rendered, SETTLED_BANNER);
	assert.doesNotMatch(rendered, GATING_BANNER, "'these gate the verdict' is false once the verdict is settled");
	assert.match(rendered, /^ {2}\[ \] typecheck-test-pass: npm run typecheck passes$/m, "the criterion is still listed");
});

test("D1: a rejected verdict is settled too", () => {
	const rendered = renderCollect("a", snapshot("rejected", REQUIRED), undefined, undefined);
	assert.match(rendered, SETTLED_BANNER);
	assert.doesNotMatch(rendered, GATING_BANNER);
});

test("D1: an unknown verdict keeps the gating banner verbatim", () => {
	// The other direction: nothing has decided this result, so the criteria really
	// are the only thing between the parent and a verdict.
	const rendered = renderCollect("a", snapshot("unknown", REQUIRED), undefined, undefined);
	assert.match(rendered, GATING_BANNER);
	assert.doesNotMatch(rendered, SETTLED_BANNER);
});

test("D1: an all-optional list renders the optional banner whatever the status", () => {
	for (const status of ["accepted", "unknown"]) {
		const rendered = renderCollect("a", snapshot(status, OPTIONAL_ONLY), undefined, undefined);
		assert.match(rendered, OPTIONAL_BANNER, `optional banner for status=${status}`);
		assert.doesNotMatch(rendered, /these gate the verdict/, `no gating claim for status=${status}`);
		assert.doesNotMatch(rendered, /already settled/, `no settled claim for status=${status}`);
	}
});

// ---------------------------------------------------------------------------
// F2 / D2 — an interrupted turn is `unknown`, never `rejected`
// ---------------------------------------------------------------------------

const attested: AcceptanceResult = { status: "accepted", level: "attested", reason: "self-report" };

/** One required criterion WITH a command, so the verify actually runs. */
const runnable = [
	{
		id: "typecheck-test-pass",
		must: "npm run typecheck 与 npm test 全绿",
		evidence: ["verification-output"],
		severity: "required" as const,
		command: "npm test",
	},
];

const red = async () => ({ code: 1, stdout: "", stderr: "1 failing" });
const green = async () => ({ code: 0, stdout: "ok\n", stderr: "" });

test("D2: an interrupted turn whose verify fails is `unknown`, not `rejected`", async () => {
	const out = await applyVerification(attested, {
		cwd: "/work",
		criteria: runnable,
		run: red,
		interrupted: true,
	});
	assert.equal(out.status, "unknown", "a turn with no output cannot be a verdict about its work");
	assert.equal(out.level, "attested", "nothing about this turn is verified");
	assert.match(out.reason ?? "", /turn was interrupted/);
	assert.match(out.reason ?? "", /not assessed/);
	assert.match(out.reason ?? "", /still ran and failed/, "the parent's verify DID run — say so");
});

test("D2: the same failure on a COMPLETED turn is still `rejected`", async () => {
	// The other direction: this is the pre-D2 behaviour and it must survive for a
	// turn that actually produced something.
	const out = await applyVerification(attested, {
		cwd: "/work",
		criteria: runnable,
		run: red,
		interrupted: false,
	});
	assert.equal(out.status, "rejected");
	assert.equal(out.level, "attested");
	assert.match(out.reason ?? "", /^verification failed \(`npm test`\)/);
});

test("D2: an interrupted turn whose verify PASSES is still `unknown`, and never claims verified", async () => {
	const out = await applyVerification(attested, {
		cwd: "/work",
		criteria: runnable,
		run: green,
		interrupted: true,
	});
	assert.equal(out.status, "unknown", "the verify passing does not make an unmeasured turn measured");
	assert.equal(out.level, "attested", "an interrupted turn must never be recorded as `verified`");
	assert.match(out.reason ?? "", /turn was interrupted/);
	assert.match(out.reason ?? "", /still ran and passed/);
});

test("D2: an interrupted turn still carries its pending criteria", async () => {
	const pending = { id: "readable-diff", must: "the diff reads well" };
	const out = await applyVerification(
		{ ...attested, pendingCriteria: [pending] },
		{ cwd: "/work", criteria: runnable, run: red, interrupted: true },
	);
	assert.deepEqual(out.pendingCriteria, [pending], "the checklist survives the interruption branch");
});

test("D2: omitting `interrupted` keeps every pre-D2 answer byte for byte (#393)", async () => {
	// Assertion 5 of the contract: the new argument is opt-in, and the existing
	// answers — including the child's own rejected verdict standing verbatim —
	// are untouched when no caller passes it.
	const pass = await applyVerification(
		{ status: "rejected", level: "attested", reason: "child says no" },
		{ cwd: "/work", criteria: runnable, run: green },
	);
	assert.deepEqual(pass, {
		status: "rejected",
		level: "verified",
		reason: "verified by `npm test` — the child's own verdict still stands (child says no)",
		pendingCriteria: [],
	});
	const fail = await applyVerification(attested, { cwd: "/work", criteria: runnable, run: red });
	assert.deepEqual(fail, {
		status: "rejected",
		level: "attested",
		reason: "verification failed (`npm test`): 1 failing",
		pendingCriteria: [],
	});
});

// ---------------------------------------------------------------------------
// F3 / D3 — the STALE line names the correct order
// ---------------------------------------------------------------------------

test("D3: the stale verification line says to commit or squash BEFORE verifying", () => {
	const rendered = renderCollect("a", snapshot("accepted", []), undefined, {
		commandCount: 3,
		outputFile: "/tmp/v.log",
		checkedAt: 1,
		stale: true,
	});
	assert.match(rendered, /^verification: STALE — the checkout changed after the pass \(3 command\(s\), \/tmp\/v\.log\)/m);
	assert.match(rendered, /— commit or squash BEFORE entering verifying, then verify again$/m);
	// The stale JUDGEMENT is unchanged: same prefix, same reason, same order.
	assert.match(rendered, /^verification: STALE — the checkout changed after the pass/m);
});

test("D3: a fresh pass gets none of that sentence", () => {
	const rendered = renderCollect("a", snapshot("accepted", []), undefined, {
		commandCount: 3,
		outputFile: "/tmp/v.log",
		checkedAt: 1,
		stale: false,
	});
	assert.match(rendered, /^verification: 3 command\(s\) · log \/tmp\/v\.log$/m);
	assert.doesNotMatch(rendered, /commit or squash/);
	assert.doesNotMatch(rendered, /STALE/);
});

// ---------------------------------------------------------------------------
// F4 / D4 — a log path is only an address when the file is there
// ---------------------------------------------------------------------------

test("D4: no journal on disk means no logPath, and doctor says in-memory only", () => {
	clearSessionErrors();
	const store = mkdtempSync(path.join(tmpdir(), "legion-demo-err-"));
	const agentDir = mkdtempSync(path.join(tmpdir(), "legion-demo-agent-"));
	try {
		// An in-memory only error: no storeRoot, so nothing is written to disk.
		configureSessionErrors({ tool: "subagent", action: "wait" });
		recordSessionError({ code: "INVALID_PARAMS", message: "`name` or `all` is required for wait" });
		const summary = summarizeSessionErrors({ storeRoot: store });
		assert.equal(summary.total, 1, "the memory ring still counts");
		assert.equal(summary.logPath, undefined, "a path to a file that does not exist is not an address");

		const report = runLegionDoctor({
			agentDir,
			storeRoot: store,
			sections: ["summary", "errors"],
			probeModels: false,
		});
		assert.match(report.text, /^- session errors: 1 \(in-memory only; no log file on disk\)$/m);
		assert.doesNotMatch(report.text, /^- session errors: 1 \(log /m, "no dead path may be named");
	} finally {
		clearSessionErrors();
		rmSync(store, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("D4: a journal that exists is still named, and by the same path", () => {
	clearSessionErrors();
	const store = mkdtempSync(path.join(tmpdir(), "legion-demo-err2-"));
	const agentDir = mkdtempSync(path.join(tmpdir(), "legion-demo-agent2-"));
	try {
		configureSessionErrors({ storeRoot: store, tool: "subagent", action: "wait" });
		recordSessionError({ code: "INVALID_PARAMS", message: "`name` or `all` is required for wait" });
		const log = path.join(store, SESSION_ERRORS_FILE);
		const summary = summarizeSessionErrors({ storeRoot: store });
		assert.equal(summary.logPath, log, "an existing journal keeps the path it always had");

		const report = runLegionDoctor({
			agentDir,
			storeRoot: store,
			sections: ["summary"],
			probeModels: false,
		});
		assert.match(report.text, /^- session errors: 1 \(log .*session-errors\.jsonl\)$/m);
		assert.doesNotMatch(report.text, /in-memory only/);
	} finally {
		clearSessionErrors();
		rmSync(store, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("D4: a store dir that exists but holds no journal file is still in-memory only", () => {
	clearSessionErrors();
	const store = mkdtempSync(path.join(tmpdir(), "legion-demo-err3-"));
	try {
		mkdirSync(store, { recursive: true });
		const summary = summarizeSessionErrors({ storeRoot: store });
		assert.equal(summary.logPath, undefined, "the DIRECTORY existing is not the FILE existing");
		assert.equal(summary.total, 0);
	} finally {
		clearSessionErrors();
		rmSync(store, { recursive: true, force: true });
	}
});
