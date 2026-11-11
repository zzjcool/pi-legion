/**
 * #P0 D1 / D10 / D11 — the order in which a `done` request is judged and paid for.
 *
 * Kept in its own file (rather than appended to `legion-tools.test.ts`) because every
 * case here pins ONE property:
 *
 *   - a `done` the team's own machine is going to refuse must not spend a contract run
 *     (D10), and
 *   - a `done` the machine would accept must never spend nothing (the P0-1 hole: an
 *     edge with no `verification_passed` requirement is not a licence to finish on a
 *     pass that belongs to another stint or another checkout — D11), and
 *   - the contract is looked for where the frozen contract says it may live (D1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import {
	LegionPostman,
	requestLegionPhase,
	verificationTree,
	type LegionCommandRunner,
} from "../../src/extension/legion-tools.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { readEventsAfter } from "../../src/legion/events.ts";
import { getNode, insertNode, updateNode } from "../../src/legion/nodes.ts";
import { DEFAULT_PHASE_MACHINE, type PhaseMachine } from "../../src/legion/phase-machine.ts";
import { evaluatePhaseTransition } from "../../src/legion/state-machine.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

type Db = ReturnType<typeof openLegionDb>;

const CONTRACT = "```legion-verify\nnpm test\n```\n";

/** A team sitting in `phase` (stint started at 50), with the root above it. */
function teamFixture(phase: string) {
	const db = openLegionDb(":memory:");
	insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 10);
	insertNode(db, {
		parentId: "root",
		name: "team",
		role: "centurion",
		status: "running",
		phase,
		phaseSince: 50,
		taskSummary: "team task",
	}, () => 50);
	return db;
}

/** A checkout dir and a run dir, both empty; the case decides where the contract goes. */
function workdirs(prefix: string) {
	const rootDir = mkdtempSync(path.join(tmpdir(), prefix));
	const cwd = path.join(rootDir, "repo");
	const runDir = path.join(rootDir, "run");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(runDir, { recursive: true });
	return { rootDir, cwd, runDir, cleanup: () => rmSync(rootDir, { recursive: true, force: true }) };
}

/** The canonical contract location: `<cwd>/.pi-legion/contract.md`. */
function writeCanonicalContract(cwd: string, text = CONTRACT): string {
	mkdirSync(path.join(cwd, ".pi-legion"), { recursive: true });
	const file = path.join(cwd, ".pi-legion", "contract.md");
	writeFileSync(file, text);
	return file;
}

/** A session whose last turn is a machine-readable verdict. */
function verdictSession(ok: boolean): string {
	const lines = [
		JSON.stringify({ type: "session", id: "legion-done-gate-order", cwd: "/tmp/project", created: "2026-01-01T00:00:00.000Z" }),
		JSON.stringify({ type: "message", message: { role: "user", content: "review" } }),
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: JSON.stringify({ ok, reason: ok ? "fine" : "broken" }) }],
				stopReason: "stop",
				usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
			},
		}),
	];
	return `${lines.join("\n")}\n`;
}

/**
 * Persist a verification result the way `runVerification` does, WITHOUT running
 * anything. The stored metadata is the ONLY input to the gate's freshness check, so
 * this is how a case puts a team in a given history: a pass from `cwd`, judged over
 * `contractFile`, at `checkedAt`.
 */
function seedStoredVerification(
	db: Db,
	nodeId: string,
	stored: { passed: boolean; checkedAt: number; cwd: string; contractFile: string },
): void {
	const tree = verificationTree(stored.cwd, readFileSync(stored.contractFile, "utf8"));
	updateNode(db, nodeId, {
		taskSummary: JSON.stringify({
			__piLegion: {
				version: 1,
				taskSummary: "team task",
				verification: {
					passed: stored.passed,
					outputFile: "/tmp/seeded.legion-verify.log",
					commandCount: 1,
					checkedAt: stored.checkedAt,
					cwd: stored.cwd,
					contractFile: stored.contractFile,
					...(tree === undefined ? {} : { tree }),
				},
			},
		}),
	}, () => stored.checkedAt);
}

/** What the node row says about its last verification, without going through internals. */
function storedVerification(db: Db, nodeId: string): Record<string, unknown> | undefined {
	const raw = getNode(db, nodeId)?.taskSummary;
	if (!raw) return undefined;
	try {
		return (JSON.parse(raw) as { __piLegion?: { verification?: Record<string, unknown> } }).__piLegion?.verification;
	} catch {
		return undefined;
	}
}

/**
 * `→ done` gated on a settled team. The condition ORDER is the machine's own and is
 * ANDed in that order, which is why the edge can be refused before anyone pays for a
 * verification: `children_settled` is asked first and answers without running git.
 */
const SETTLED_DONE: PhaseMachine = {
	start: "verifying",
	phases: [
		{ id: "verifying", next: [{ to: "done", require: ["children_settled", "verification_passed"] }] },
		{ id: "done", terminal: true, next: [] },
	],
};

/**
 * Every child failed. The author still asked for a pass before `done` — the point of
 * the case is that the machine's `children_none_failed` refusal is terminal on its own
 * and must not be paid for first.
 */
const NONE_FAILED_DONE: PhaseMachine = {
	start: "implementing",
	phases: [
		{ id: "implementing", next: [{ to: "done", require: ["children_none_failed", "verification_passed"] }] },
		{ id: "done", terminal: true, next: [] },
	],
};

/**
 * `→ done` with NO requirement at all — the P0-1 shape. Nothing in the machine asks for
 * a verification here; the TOOL is the only thing standing between a stale pass and a
 * finished team, so this is the machine that catches a "pre-judgement said yes" shortcut.
 */
const UNGATED_DONE: PhaseMachine = {
	start: "verifying",
	phases: [
		{ id: "verifying", next: [{ to: "done" }] },
		{ id: "done", terminal: true, next: [] },
	],
};

/** A real git checkout with `calc.mjs` and an untracked-free baseline commit. */
function gitCheckout(dir: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "calc.mjs"), "export const add = (a, b) => a + b;\n");
	const git = (...args: string[]) => execFileSync(
		"git",
		["-C", dir, "-c", "user.name=gate", "-c", "user.email=gate@example.invalid", "-c", "commit.gpgsign=false", ...args],
		{ stdio: "ignore" },
	);
	git("init");
	git("add", ".");
	git("commit", "-m", "baseline");
}

// ---------------------------------------------------------------------------
// D10 — the refusal shape the gate reads
// ---------------------------------------------------------------------------

test("#P0 D10: a refusal names the condition that failed, forced transitions included", () => {
	const running = evaluatePhaseTransition({
		from: "verifying",
		to: "done",
		children: [{ id: "w", role: "worker", status: "running" }],
		verificationPassed: false,
		machine: SETTLED_DONE,
	}, () => 5);
	assert.equal(running.allowed, false);
	assert.equal(
		running.allowed === false ? running.failed : undefined,
		"children_settled",
		"the condition travels with the refusal — the done gate reads it instead of re-deriving the machine",
	);

	const forced = evaluatePhaseTransition({
		from: "implementing",
		to: "done",
		children: [{ id: "w", role: "worker", status: "failed" }],
		verificationPassed: false,
		machine: NONE_FAILED_DONE,
	}, () => 5);
	assert.equal(forced.allowed, false);
	if (forced.allowed) return;
	assert.equal(forced.failed, "children_none_failed", "the forced branch carries the condition too");
	assert.equal(forced.forcedTransition?.reason, "all_children_failed");

	// A refusal that did NOT come from the edge's `require` list has no condition to
	// name — the gate must not read that absence as "verification_passed".
	const badEdge = evaluatePhaseTransition({
		from: "verifying",
		to: "done",
		children: [],
		verificationPassed: false,
		actorRole: "worker",
		machine: { start: "verifying", phases: [{ id: "verifying", next: [{ to: "done", actorRole: "centurion" }] }, { id: "done", terminal: true, next: [] }] },
	}, () => 5);
	assert.equal(badEdge.allowed, false);
	assert.equal(badEdge.allowed === false ? badEdge.failed : "set", undefined, "an actor gate names no condition");
});

// ---------------------------------------------------------------------------
// D10 — judge the edge first, pay second
// ---------------------------------------------------------------------------

test("#P0 D10: a doomed done (a child still running) is refused WITHOUT running the contract", async () => {
	const dirs = workdirs("legion-gate-order-");
	const db = teamFixture("verifying");
	const commands: string[] = [];
	const runCommand: LegionCommandRunner = async (command) => {
		commands.push(command);
		return { code: 0, stdout: "green", stderr: "" };
	};
	try {
		const contractFile = writeCanonicalContract(dirs.cwd);
		// A red pass from this stint: a request that COULD be judged on its own merits
		// still has to re-measure. Nothing about the contract is wrong here — the point
		// is that a green run would change nobody's mind.
		seedStoredVerification(db, "root.team", { passed: false, checkedAt: 60, cwd: dirs.cwd, contractFile });
		insertNode(db, { parentId: "root.team", name: "worker", role: "worker", status: "running" }, () => 60);
		const before = getNode(db, "root.team");
		const result = await requestLegionPhase(db, "root.team", "done", {
			cwd: dirs.cwd, runDir: dirs.runDir, now: () => 100, machine: SETTLED_DONE, runCommand,
			sendSelfMessage() {},
		});
		assert.equal(result.ok, false, `a running child is a refusal, not a report: ${result.message}`);
		assert.match(result.message, /still running|settle/i, "the refusal still says what is missing");
		assert.deepEqual(commands, [], "a transition that cannot happen must not be paid for");
		const after = getNode(db, "root.team");
		assert.equal(after?.phase, "verifying");
		assert.equal(after?.taskSummary, before?.taskSummary, "a refused request writes no verification receipt");
		assert.deepEqual(readEventsAfter(db, 0).filter((event) => event.type === "phase_change"), [], "and moves nothing");
	} finally {
		db.close();
		dirs.cleanup();
	}
});

test("#P0 D10: every child failed forces `failed` immediately, without running the contract", async () => {
	const dirs = workdirs("legion-gate-forced-");
	const db = teamFixture("implementing");
	const commands: string[] = [];
	const runCommand: LegionCommandRunner = async (command) => {
		commands.push(command);
		return { code: 0, stdout: "green", stderr: "" };
	};
	try {
		writeCanonicalContract(dirs.cwd);
		insertNode(db, { parentId: "root.team", name: "worker", role: "worker", status: "failed" }, () => 60);
		const result = await requestLegionPhase(db, "root.team", "done", {
			cwd: dirs.cwd, runDir: dirs.runDir, now: () => 100, machine: NONE_FAILED_DONE, runCommand,
			sendSelfMessage() {},
		});
		assert.equal(result.ok, false, result.message);
		assert.deepEqual(commands, [], "a team that cannot finish must not be charged for finding out");
		const node = getNode(db, "root.team");
		assert.equal(node?.phase, "failed", "the forced terminal transition is immediately reachable");
		const changes = readEventsAfter(db, 0).filter((event) => event.type === "phase_change");
		assert.equal(changes.length, 1, "one phase change: the forced one");
		assert.equal((changes[0]?.data as { forced?: boolean } | null)?.forced, true);
		assert.equal((changes[0]?.data as { reason?: string } | null)?.reason, "all_children_failed");
		assert.equal(node?.taskSummary, "team task", "the refusal ran nothing, so it wrote nothing");
	} finally {
		db.close();
		dirs.cleanup();
	}
});

test("#P0 D10/P0-1: an edge that never asks for a pass still re-measures a stale one", async () => {
	const dirs = workdirs("legion-gate-stale-");
	const db = teamFixture("verifying");
	const commands: string[] = [];
	const runCommand: LegionCommandRunner = async (command) => {
		commands.push(command);
		return { code: 0, stdout: "green", stderr: "" };
	};
	try {
		const contractFile = writeCanonicalContract(dirs.cwd);
		// A GREEN pass recorded in ANOTHER stint (`checkedAt` 20 < `phaseSince` 50): the
		// exact row a "pre-judgement said yes, so go" shortcut would read as permission.
		seedStoredVerification(db, "root.team", { passed: true, checkedAt: 20, cwd: dirs.cwd, contractFile });
		const result = await requestLegionPhase(db, "root.team", "done", {
			cwd: dirs.cwd, runDir: dirs.runDir, now: () => 100, machine: UNGATED_DONE, runCommand,
			sendSelfMessage() {},
		});
		assert.equal(result.ok, true, result.message);
		assert.equal(result.phase, "done");
		assert.deepEqual(commands, ["npm test"], "the edge asks for no verification — the finish still costs a fresh one");
		assert.match(result.message, /Verification passed \(1 command\(s\)\)/, "and the agent is told what it paid for");
		assert.equal(storedVerification(db, "root.team")?.checkedAt, 100, "the pass that let the team finish was measured NOW");
	} finally {
		db.close();
		dirs.cleanup();
	}
});

// ---------------------------------------------------------------------------
// D11 — a pass belongs to the checkout it judged
// ---------------------------------------------------------------------------

test("#P0 D11: a pass recorded in another checkout is stale even when the tree is identical", async () => {
	const dirs = workdirs("legion-gate-checkout-");
	const db = teamFixture("verifying");
	const commands: Array<{ command: string; cwd: string }> = [];
	const runCommand: LegionCommandRunner = async (command, cwd) => {
		commands.push({ command, cwd });
		return { code: 0, stdout: "green", stderr: "" };
	};
	try {
		gitCheckout(dirs.cwd);
		const contractFile = writeCanonicalContract(dirs.cwd);
		// The checkout is REPLACED: a byte-identical copy, same commit, same status —
		// `git` cannot tell them apart, which is exactly why a pass records WHERE it ran.
		const replacement = path.join(dirs.rootDir, "repo-replacement");
		// `cp -a`, not `fs.cpSync`: copying a `.git` tree with `cpSync` intermittently
		// fails with ENOENT on `.git/objects` under load, and "a byte-identical copy"
		// is exactly what `-a` means.
		execFileSync("cp", ["-a", dirs.cwd, replacement], { stdio: "ignore" });
		const replacementContract = path.join(replacement, ".pi-legion", "contract.md");
		assert.equal(
			verificationTree(replacement, readFileSync(replacementContract, "utf8")),
			verificationTree(dirs.cwd, readFileSync(contractFile, "utf8")),
			"the two checkouts hash identically — only the PATH can make the old pass stale",
		);
		seedStoredVerification(db, "root.team", { passed: true, checkedAt: 60, cwd: dirs.cwd, contractFile });
		updateNode(db, "root.team", { worktreePath: replacement }, () => 60);
		const result = await requestLegionPhase(db, "root.team", "done", {
			// The caller still points at the OLD directory; the team's checkout is the one
			// recorded on the node, and that is what the pass has to describe.
			cwd: dirs.cwd, runDir: dirs.runDir, now: () => 100, machine: UNGATED_DONE, runCommand,
			sendSelfMessage() {},
		});
		assert.equal(result.ok, true, result.message);
		assert.equal(result.phase, "done");
		assert.deepEqual(commands, [{ command: "npm test", cwd: replacement }], "re-measured once, in the checkout that would be delivered");
		assert.equal(storedVerification(db, "root.team")?.cwd, replacement, "the new pass records the checkout it really judged");
	} finally {
		db.close();
		dirs.cleanup();
	}
});

test("#P0 D11: the supervisor will not complete a team whose pass belongs to another checkout", async () => {
	const dirs = workdirs("legion-gate-supervisor-");
	const db = teamFixture("verifying");
	try {
		const contractFile = writeCanonicalContract(dirs.cwd);
		// Same tree, different directory: the probe alone says "unchanged", so only the
		// recorded path can stop this tick from completing the team.
		const replacement = path.join(dirs.rootDir, "repo-replacement");
		mkdirSync(path.join(replacement, ".pi-legion"), { recursive: true });
		writeFileSync(path.join(replacement, ".pi-legion", "contract.md"), CONTRACT);
		seedStoredVerification(db, "root.team", { passed: true, checkedAt: 60, cwd: dirs.cwd, contractFile });
		updateNode(db, "root.team", { worktreePath: replacement }, () => 60);
		const messages: string[] = [];
		const postman = new LegionPostman({
			db, nodeId: "root.team", supervisor: new FakeSupervisor(), machine: UNGATED_DONE,
			now: () => 100, intervalMs: 10_000, sendSelfMessage: (text) => messages.push(text),
		});
		await postman.tick();
		assert.equal(getNode(db, "root.team")?.phase, "verifying", "a pass from another checkout must not complete the team");
		assert.equal(
			messages.filter((message) => /checkout changed after legion-verify passed/.test(message)).length,
			1,
			"the agent is told why, once",
		);
		postman.stop();
	} finally {
		db.close();
		dirs.cleanup();
	}
});

// ---------------------------------------------------------------------------
// D1 — the contract may live in the run dir
// ---------------------------------------------------------------------------

test("#P0 D1: a recorded contract path that vanished cannot shadow the run-dir contract", async () => {
	const dirs = workdirs("legion-contract-ghost-");
	const db = teamFixture("verifying");
	const commands: string[] = [];
	const runCommand: LegionCommandRunner = async (command) => {
		commands.push(command);
		return { code: 0, stdout: "green", stderr: "" };
	};
	try {
		// The node remembers a contract file that no longer exists (the team's contract moved
		// to the run dir). If the gate resolved ONE path and the verifier read ANOTHER, the
		// check would pass and the run would measure nothing — finishing on a 0-command pass.
		const ghost = path.join(dirs.cwd, ".pi-legion", "contract.md");
		writeFileSync(path.join(dirs.runDir, "contract.md"), CONTRACT);
		updateNode(db, "root.team", { contractPath: ghost }, () => 50);
		const result = await requestLegionPhase(db, "root.team", "done", {
			cwd: dirs.cwd, runDir: dirs.runDir, now: () => 100, machine: UNGATED_DONE, runCommand,
			sendSelfMessage() {},
		});
		assert.equal(result.ok, true, result.message);
		assert.deepEqual(commands, ["npm test"], "the contract the gate accepted is the one that runs");
		assert.match(result.message, /Verification passed \(1 command\(s\)\)/, "not a 0-command pass");
		assert.equal(storedVerification(db, "root.team")?.contractFile, path.join(dirs.runDir, "contract.md"));
	} finally {
		db.close();
		dirs.cleanup();
	}
});

test("#P0 D1: a contract kept only in the run dir is read by both the entry gate and the verification", async () => {
	const dirs = workdirs("legion-contract-rundir-");
	const db = teamFixture("planning");
	const commands: Array<{ command: string; cwd: string }> = [];
	const runCommand: LegionCommandRunner = async (command, cwd) => {
		commands.push({ command, cwd });
		return { code: 0, stdout: "green", stderr: "" };
	};
	try {
		// A read-only team: nothing writable in the checkout, so no `.pi-legion/` there.
		const runDirContract = path.join(dirs.runDir, "contract.md");
		writeFileSync(runDirContract, CONTRACT);
		const options = {
			cwd: dirs.cwd, runDir: dirs.runDir, now: () => 100,
			machine: DEFAULT_PHASE_MACHINE, runCommand, sendSelfMessage() {},
		};
		const toImplementing = await requestLegionPhase(db, "root.team", "implementing", options);
		assert.equal(toImplementing.ok, true, `the run-dir contract IS a contract: ${toImplementing.message}`);
		assert.equal(getNode(db, "root.team")?.contractPath, runDirContract, "the RECORDED path is the file that was read");

		const reviewerSession = path.join(dirs.runDir, "reviewer.jsonl");
		writeFileSync(reviewerSession, verdictSession(true));
		insertNode(db, { parentId: "root.team", name: "worker", role: "worker", status: "settled" }, () => 101);
		insertNode(db, { parentId: "root.team", name: "reviewer", role: "reviewer", status: "settled", sessionFile: reviewerSession }, () => 102);
		assert.equal((await requestLegionPhase(db, "root.team", "reviewing", options)).ok, true);
		const verifying = await requestLegionPhase(db, "root.team", "verifying", options);
		assert.equal(verifying.ok, true, verifying.message);
		assert.equal(verifying.phase, "done");
		assert.deepEqual(
			commands,
			[{ command: "npm test", cwd: dirs.cwd }],
			"the success phase's verification read the same file, and it is the only one that could have a command",
		);
		assert.equal(storedVerification(db, "root.team")?.contractFile, runDirContract, "`contractFile` records the file actually read");
	} finally {
		db.close();
		dirs.cleanup();
	}
});

test("#P0 D10: require ORDER does not decide whether a doomed done pays", async () => {
	const dirs = workdirs("legion-gate-order-doomed-");
	const db = teamFixture("verifying");
	const commands: string[] = [];
	const runCommand: LegionCommandRunner = async (command) => {
		commands.push(command);
		return { code: 0, stdout: "green", stderr: "" };
	};
	// `verification_passed` FIRST: the machine reports the first failing condition, so a
	// gate that probes "what if there were no pass" would see verification as the blocker
	// and buy a contract run that a still-running child makes useless.
	const gatedFirst: PhaseMachine = {
		start: "verifying",
		phases: [
			{ id: "verifying", next: [{ to: "done", require: ["verification_passed", "children_settled"] }] },
			{ id: "done", terminal: true, next: [] },
		],
	};
	try {
		writeCanonicalContract(dirs.cwd);
		insertNode(db, { parentId: "root.team", name: "w", role: "worker", status: "running" }, () => 50);
		const result = await requestLegionPhase(db, "root.team", "done", {
			cwd: dirs.cwd, runDir: dirs.runDir, now: () => 100, machine: gatedFirst, runCommand,
			sendSelfMessage() {},
		});
		assert.equal(result.ok, false, "a team with a running child cannot finish");
		assert.deepEqual(commands, [], "and must not pay for a verification the edge cannot use");
		assert.equal(getNode(db, "root.team")?.phase, "verifying");
		assert.match(String(result.message), /still running|settle/i, "the refusal names the real blocker");
	} finally {
		db.close();
		dirs.cleanup();
	}
});

