import { test } from "node:test";
import assert from "node:assert/strict";
import {
	applyVerification,
	defaultVerifyRunner,
	needsVerification,
	verifyCommandOf,
} from "../../src/runs/acceptance.ts";
import type { AcceptanceResult } from "../../src/shared/types.ts";

const attested: AcceptanceResult = {
	status: "accepted",
	level: "attested",
	reason: "self-report",
};

const criteria = [
	{
		id: "typecheck-test-pass",
		must: "npm run typecheck 与 npm test 全绿",
		evidence: ["verification-output"],
		severity: "required" as const,
	},
];

/** Same required criterion, but carrying the explicit command (#393). */
const runnableCriteria = [{ ...criteria[0]!, command: "npm test" }];

test("needsVerification is true only for required verification-output criteria", () => {
	assert.equal(needsVerification(undefined), false);
	assert.equal(needsVerification([]), false);
	assert.equal(
		needsVerification([{ id: "facts", must: "paths", evidence: ["facts"] }]),
		false,
	);
	assert.equal(needsVerification(criteria), true);
	assert.equal(
		needsVerification([
			{ ...criteria[0]!, severity: "optional" },
		]),
		false,
	);
});

test("applyVerification skips when there is nothing to run", async () => {
	const runs: string[] = [];
	const out = await applyVerification(attested, {
		cwd: "/tmp",
		criteria: [{ id: "facts", must: "paths", evidence: ["facts"] }],
		run: async (command) => {
			runs.push(command);
			return { code: 0, stdout: "", stderr: "" };
		},
	});
	assert.equal(runs.length, 0);
	assert.equal(out.level, "attested");
});

test("applyVerification keeps attested when the criterion has no command", async () => {
	const runs: string[] = [];
	const out = await applyVerification(attested, {
		cwd: "/work",
		criteria,
		run: async (command) => {
			runs.push(command);
			return { code: 0, stdout: "ok\n", stderr: "" };
		},
	});
	assert.equal(runs.length, 0, "must not guess a command");
	assert.equal(out.status, "accepted");
	assert.equal(out.level, "attested");
	assert.match(out.reason ?? "", /no command/);
	assert.ok(
		out.pendingCriteria?.some((c) => c.id === "typecheck-test-pass"),
		"criterion surfaces as pending for the parent",
	);
});

test("applyVerification rejects when the command fails", async () => {
	const out = await applyVerification(attested, {
		cwd: "/work",
		criteria: [
			{
				...criteria[0]!,
				command: "make test",
			},
		],
		run: async () => ({ code: 1, stdout: "fail\n", stderr: "boom" }),
	});
	assert.equal(out.status, "rejected");
	assert.equal(out.level, "attested");
	assert.match(out.reason ?? "", /boom|fail/);
});

test("applyVerification runs a command-bearing criterion even when the child said rejected (#393)", async () => {
	const runs: string[] = [];
	const out = await applyVerification(
		{ status: "rejected", level: "attested", reason: "child says no" },
		{
			cwd: "/work",
			criteria: runnableCriteria,
			run: async (command) => {
				runs.push(command);
				return { code: 0, stdout: "ok\n", stderr: "" };
			},
		},
	);
	// The command must actually run: a child's own `ok: false` is not a licence
	// to skip verification (docs/design.md §10.3 — the precondition is the
	// explicit `command`, not the child's self-report).
	assert.deepEqual(runs, ["npm test"], "the verify command must run");
	// …and it must not silently overturn the child's verdict either.
	assert.equal(out.status, "rejected", "the child's own verdict still stands");
	assert.equal(out.level, "verified", "the commands did pass, so the level is verified");
	assert.match(out.reason ?? "", /verified by `npm test`/);
	assert.match(out.reason ?? "", /child says no/);
});

test("applyVerification keeps an unknown verdict when the commands pass (#393)", async () => {
	const out = await applyVerification(
		{ status: "unknown", level: "none", reason: "no verdict parsed" },
		{
			cwd: "/work",
			criteria: runnableCriteria,
			run: async () => ({ code: 0, stdout: "ok\n", stderr: "" }),
		},
	);
	assert.equal(out.status, "unknown");
	assert.equal(out.level, "verified");
	assert.match(out.reason ?? "", /verified by `npm test`/);
	assert.match(out.reason ?? "", /no verdict parsed/);
});

test("applyVerification rejects on a red command even when the child said rejected (#393)", async () => {
	const out = await applyVerification(
		{ status: "rejected", level: "attested", reason: "child says no" },
		{
			cwd: "/work",
			criteria: runnableCriteria,
			run: async () => ({ code: 1, stdout: "", stderr: "1 failing" }),
		},
	);
	assert.equal(out.status, "rejected");
	assert.equal(out.level, "attested");
	// The `verification failed (` prefix is what index.ts inlines on — keep it.
	assert.ok(
		(out.reason ?? "").startsWith("verification failed (`npm test`)"),
		`unexpected reason: ${out.reason}`,
	);
	assert.match(out.reason ?? "", /1 failing/);
});

test("verifyCommandOf returns the criterion command, else undefined", () => {
	assert.equal(verifyCommandOf(undefined), undefined);
	assert.equal(verifyCommandOf(criteria), undefined);
	assert.equal(
		verifyCommandOf([
			{
				id: "custom",
				must: "pytest",
				evidence: ["verification-output"],
				severity: "required",
				command: "pytest -q",
			},
		]),
		"pytest -q",
	);
});

test("applyVerification runs the criterion command", async () => {
	const out = await applyVerification(attested, {
		cwd: "/work",
		criteria: [
			{
				id: "custom",
				must: "pytest",
				evidence: ["verification-output"],
				severity: "required",
				command: "pytest -q",
			},
		],
		run: async (command, cwd) => {
			assert.equal(command, "pytest -q");
			assert.equal(cwd, "/work");
			return { code: 0, stdout: "ok\n", stderr: "" };
		},
	});
	assert.equal(out.level, "verified");
	assert.match(out.reason ?? "", /pytest -q/);
});

test("defaultVerifyRunner times out a hung command", async () => {
	const started = Date.now();
	const result = await defaultVerifyRunner("sleep 30", process.cwd(), 80);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /timed out/);
	assert.ok(Date.now() - started < 5_000);
});

test("applyVerification runs every command in order and names the first failure", async () => {
	const calls: Array<{ command: string; cwd: string }> = [];
	const run = async (command: string, cwd: string) => {
		calls.push({ command, cwd });
		// Second command fails; the third must never run.
		return command === "npm test"
			? { code: 1, stdout: "", stderr: "1 failing" }
			: { code: 0, stdout: "", stderr: "" };
	};
	const out = await applyVerification(attested, {
		cwd: "/work",
		criteria: [
			{
				id: "a",
				must: "typecheck",
				evidence: ["verification-output"],
				severity: "required",
				command: "npm run typecheck",
			},
			{
				id: "b",
				must: "tests",
				evidence: ["verification-output"],
				severity: "required",
				command: "npm test",
			},
			{
				id: "c",
				must: "integration",
				evidence: ["verification-output"],
				severity: "required",
				command: "npm run test:integration",
			},
		],
		run,
	});
	assert.deepEqual(calls.map((c) => c.command), ["npm run typecheck", "npm test"]);
	assert.equal(out.status, "rejected");
	assert.match(out.reason ?? "", /npm test/);
	assert.doesNotMatch(out.reason ?? "", /test:integration/);
});

test("applyVerification success names every command that had to pass", async () => {
	const out = await applyVerification(attested, {
		cwd: "/work",
		criteria: [
			{
				id: "a",
				must: "typecheck",
				evidence: ["verification-output"],
				severity: "required",
				command: "npm run typecheck",
			},
			{
				id: "b",
				must: "tests",
				evidence: ["verification-output"],
				severity: "required",
				command: "npm test",
			},
		],
		run: async () => ({ code: 0, stdout: "", stderr: "" }),
	});
	assert.equal(out.status, "accepted");
	assert.equal(out.level, "verified");
	assert.match(out.reason ?? "", /`npm run typecheck` && `npm test`/);
});

test("D393-6: a long child reason is truncated inside the verified reason", async () => {
	const long = `start ${"x".repeat(4_000)} TAIL-MARKER`;
	const out = await applyVerification(
		{ status: "rejected", level: "attested", reason: long },
		{
			cwd: "/work",
			criteria: runnableCriteria,
			run: async () => ({ code: 0, stdout: "ok\n", stderr: "" }),
		},
	);
	const reason = out.reason ?? "";
	const prefix = "verified by `npm test` — the child's own verdict still stands (";
	const suffix = ")";
	assert.ok(reason.startsWith(prefix), `unexpected reason: ${reason.slice(0, 120)}`);
	assert.ok(reason.endsWith(suffix));
	const carriedReason = reason.slice(prefix.length, reason.length - suffix.length);
	// Same 1500-char budget as the red path, with the marker included in it.
	assert.ok(carriedReason.length <= 1_500, `child reason not capped: ${carriedReason.length} chars`);
	assert.match(carriedReason, /…$/, "truncation is marked with an ellipsis");
	assert.doesNotMatch(reason, /TAIL-MARKER/, "the dropped tail must not survive");
});

test("D393-7: a pending criterion carrying a command that never runs is not swallowed", async () => {
	const runs: string[] = [];
	// A pending criterion WITH a command, but without `verification-output`: it is
	// never executed this round, so dropping it silently loses the only record
	// that the parent still has to confirm it.
	const manualCheck = {
		id: "manual-diff-review",
		must: "parent reviews the diff",
		evidence: ["facts"],
		severity: "required" as const,
		command: "git diff --stat",
	};
	const runnable = { ...runnableCriteria[0]! };
	const out = await applyVerification(
		{ ...attested, pendingCriteria: [manualCheck, runnable] },
		{
			cwd: "/work",
			criteria: runnableCriteria,
			run: async (command) => {
				runs.push(command);
				return { code: 0, stdout: "ok\n", stderr: "" };
			},
		},
	);
	assert.deepEqual(runs, ["npm test"], "only the runnable criterion's command ran");
	const ids = (out.pendingCriteria ?? []).map((criterion) => criterion.id);
	assert.deepEqual(ids, ["manual-diff-review"], "the unexecuted criterion stays pending; the run one is resolved");
});
