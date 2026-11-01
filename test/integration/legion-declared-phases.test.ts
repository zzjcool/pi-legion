/**
 * #371 e2e — the state machine is DECLARED by the root at dispatch time.
 *
 * Contract: `docs/contracts/centurion-declared-phases-v1.md`.
 *
 * The three shapes contract §6 asks for:
 *
 *   1. **solo declared** — `planning → implementing → done` with ZERO children
 *      walks the machine end to end and the parent's collect accepts the verdict
 *      (`attested` without `verify:`, `verified` with it). Before #371 this shape
 *      had no legal finish: `done`'s only entry was `verifying`, and `verifying`'s
 *      only entry demanded a settled child.
 *   2. **team declared** — the built-in pipeline declared explicitly behaves
 *      exactly as it did when it was implicit (invariant I1): the contract file,
 *      the settled children, the `ok:true` verdict, the `legion-verify` run and
 *      the collection prompt all still gate the same doors.
 *   3. **undeclared** — no `phases`: no phase, no `legion_phase`, no collection
 *      prompt, and a normal verdict (invariant I2).
 *
 * …plus the dispatch-side refusals G2/G3/G4 and invariant I7 (a refused dispatch
 * leaves no artifact behind). G1 lives in `legion-tree.test.ts` (#281), where the
 * whole non-root matrix already is.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerLegionTools, type LegionCommandRunner } from "../../src/extension/legion-tools.ts";
import { parsePhaseMachine } from "../../src/agents/agents.ts";
import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { legionDbPath, openLegionDb } from "../../src/legion/db.ts";
import { getNode, insertNode } from "../../src/legion/nodes.ts";
import { DEFAULT_PHASE_MACHINE, type PhaseMachine } from "../../src/legion/phase-machine.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { LEGION_PHASES_ENV } from "../../src/runs/args.ts";
import { RunStore } from "../../src/runs/store.ts";
import { InMemoryUIProxy } from "../../src/supervisor/ui-proxy.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import { ErrorCodes, SubagentError, type AgentConfig } from "../../src/shared/types.ts";

/** `planning → implementing → done`, no conditions: the zero-child workflow (§6.1). */
const SOLO_MACHINE: PhaseMachine = {
	start: "planning",
	phases: [
		{ id: "planning", next: [{ to: "implementing" }] },
		{ id: "implementing", next: [{ to: "done" }] },
		{ id: "done", terminal: true, next: [] },
	],
};

/**
 * Well formed, and a LOOP: nothing here is terminal, so no team could ever finish.
 * `validatePhaseMachine` accepts it (no dead end, start reachable and not
 * terminal) — which is the entire reason G4 exists.
 */
const LOOP_MACHINE = [
	{ id: "a", next: [{ to: "b" }] },
	{ id: "b", next: [{ to: "a" }] },
];

function agent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		description: `${name} integration role`,
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: `You are the ${name}.`,
		source: "project",
		filePath: `/fixtures/${name}.md`,
		...overrides,
	};
}

const centurion = (overrides: Partial<AgentConfig> = {}) =>
	agent("centurion", { allowNestedSubagents: true, maxSubagentDepth: 2, worktree: true, ...overrides });

/** A git repo + a root run + a ledger with the root row — the e2e floor. */
interface Fixture {
	repo: string;
	store: RunStore;
	rootRunId: string;
	runDir: string;
	db: ReturnType<typeof openLegionDb>;
	supervisor: FakeSupervisor;
	/** Orchestrator acting as the ROOT shell (`nodeId === "root"`). */
	root: Orchestrator;
	cleanup: () => void;
}

function fixture(options: { verifyRunner?: (command: string, cwd: string, timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }> } = {}): Fixture {
	const sandbox = mkdtempSync(path.join(tmpdir(), "legion-declared-phases-e2e-"));
	const repo = path.join(sandbox, "repo");
	mkdirSync(repo, { recursive: true });
	const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
	git(["init", "-q"]);
	git(["config", "user.email", "legion-test@example.invalid"]);
	git(["config", "user.name", "Legion integration test"]);
	writeFileSync(path.join(repo, "README.md"), "legion #371 fixture\n");
	git(["add", "README.md"]);
	git(["commit", "-m", "test fixture", "-q"]);

	const store = new RunStore({ rootDir: path.join(repo, ".pi-subagents") });
	const rootRun = store.createRun({ task: "#371 declared phases", cwd: repo, maxDepth: 4, nodeId: "root", herdr: { supervisor: "rpc" } });
	const dbPath = legionDbPath(store.runDir(rootRun.runId));
	const db = openLegionDb(dbPath);
	insertNode(db, { id: "root", parentId: null, name: "root", role: "root", runId: rootRun.runId, status: "running", taskSummary: rootRun.task });
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	const root = new Orchestrator({
		supervisor,
		runDir: store.runDir(rootRun.runId),
		cwd: repo,
		maxDepth: 4,
		legion: {
			db, dbPath, nodeId: "root", runId: rootRun.runId, runStore: store,
			settings: { maxDepth: 4, maxChildrenPerNode: 8, maxActiveNodes: 30, verifyCommandTimeoutMs: 5_000 },
			eventBus: createLegionEventBus(),
		},
		...(options.verifyRunner ? { verifyRunner: options.verifyRunner } : {}),
	});
	return {
		repo,
		store,
		rootRunId: rootRun.runId,
		runDir: store.runDir(rootRun.runId),
		db,
		supervisor,
		root,
		cleanup: () => { db.close(); rmSync(sandbox, { recursive: true, force: true }); },
	};
}

/** The tool set a live centurion child registers for itself. */
function toolsFor(fx: Fixture, nodeId: string, cwd: string, machine?: PhaseMachine, runCommand?: LegionCommandRunner) {
	const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<{ content?: Array<{ text?: string }> }> }>();
	const pi = {
		registerTool(tool: unknown) {
			const typed = tool as { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content?: Array<{ text?: string }> }> };
			tools.set(typed.name, typed);
		},
	};
	const messages: string[] = [];
	registerLegionTools(pi as unknown as ExtensionAPI, {
		db: fx.db,
		nodeId,
		role: "centurion",
		cwd,
		runDir: fx.runDir,
		settings: { verifyCommandTimeoutMs: 5_000 },
		eventBus: createLegionEventBus(),
		sendSelfMessage: (text) => messages.push(text),
		...(machine ? { machine } : {}),
		...(runCommand ? { runCommand } : {}),
	});
	return { tools, messages };
}

/** Mirror `launch()`'s child record into the run store (the e2e convention here). */
async function record(fx: Fixture, handle: { name: string; child: { nodeId?: string } }) {
	if (fx.store.findChild(fx.rootRunId, handle.name)) {
		await fx.store.updateChild(fx.rootRunId, handle.name, (child) => Object.assign(child, handle.child));
	} else {
		await fx.store.addChild(fx.rootRunId, handle.child as never);
	}
}

async function launchTeam(fx: Fixture, options: { phases?: unknown; start?: string; agent?: AgentConfig } = {}) {
	const handle = await fx.root.launch({
		agent: options.agent ?? centurion(),
		task: "Own the slice described in the task.",
		...(options.phases !== undefined ? { phases: options.phases } : {}),
		...(options.start !== undefined ? { start: options.start } : {}),
	});
	assert.ok(handle.child.nodeId, "a legion launch must record a node id");
	await record(fx, handle);
	return { handle, node: getNode(fx.db, handle.child.nodeId!)! };
}

/**
 * Write one child of `parentId` into the ledger, with a session file whose last
 * turn is `verdict` — the shape `requestLegionPhase` reads (`extractVerdict` over
 * `parseSessionFile`).
 */
function childOf(fx: Fixture, parentId: string, name: string, status: "settled" | "failed" | "running" | "retired", verdict?: string): string {
	const sessionFile = path.join(fx.repo, `${parentId}.${name}.jsonl`);
	const lines: Array<Record<string, unknown>> = [{ type: "session", id: `${parentId}.${name}`, cwd: fx.repo, created: "2026-01-01T00:00:00.000Z" }];
	lines.push({ type: "message", message: { role: "user", content: "go" } });
	if (verdict !== undefined) {
		lines.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: verdict }], stopReason: "stop", usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } } });
	}
	writeFileSync(sessionFile, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	return insertNode(fx.db, { parentId, name, role: name, sessionFile, status }, () => Date.now()).id;
}

async function collect(fx: Fixture, name: string, text: string) {
	const collecting = fx.root.collect(name, { timeoutMs: 1_000 });
	fx.supervisor.settle(name, { text });
	const delivered = await collecting;
	await fx.root.retire(name);
	return delivered;
}

// ---------------------------------------------------------------------------
// §6.1 — solo declaration
// ---------------------------------------------------------------------------

test("#371 e2e solo: a declared planning→implementing→done team finishes with zero children", async () => {
	const fx = fixture();
	try {
		const { handle, node } = await launchTeam(fx, { phases: SOLO_MACHINE });
		// Born in ITS machine's start phase, not in the built-in literal.
		assert.equal(node.phase, "planning");

		// The declaration reaches the child the only way it can: the identity
		// overlay. What the child then parses is what the root declared, normalized
		// by the same validator the card layer uses.
		const declared = fx.supervisor.spawns[0]?.input.env?.[LEGION_PHASES_ENV];
		assert.ok(declared, "the declared machine must reach the child process");
		const machine = parsePhaseMachine(declared, LEGION_PHASES_ENV);
		assert.ok(machine, "the child must be able to read its own declaration");
		const ids = machine.phases.map((phase) => phase.id);
		for (const id of ["planning", "implementing", "done"]) assert.ok(ids.includes(id), `machine is missing '${id}': ${ids}`);

		const { tools, messages } = toolsFor(fx, node.id, handle.child.worktreePath!, machine);
		const phase = tools.get("legion_phase");
		assert.ok(phase, "a DECLARED team owns legion_phase");

		// ONE request is the whole walk. `implementing` is this machine's success
		// phase (it is the phase with an exit to `done`), so entering it runs the
		// contract's `legion-verify` block — empty here, which passes by contract —
		// and then takes the declared `implementing → done` edge. That is the same
		// verified-completion path the built-in pipeline has always had; what #371
		// added is that a ZERO-CHILD team finally has one at all (before it, `done`
		// was reachable only from `verifying`, and `verifying` only from a settled
		// child — the team could only fail or be aborted).
		const toImplementing = await phase.execute("solo-1", { to: "implementing" });
		const receipt = (toImplementing.content ?? []).map((item) => item.text ?? "").join("\n");
		assert.match(receipt, /automatically advanced to done/);
		assert.equal(getNode(fx.db, node.id)?.phase, "done", `receipt: ${receipt}`);
		assert.ok(messages.some((message) => /squash/.test(message)), "a declared team still earns the collection prompt");

		const delivered = await collect(fx, handle.name, '{"ok":true,"reason":"Wrote the one file and opened nothing."}');
		assert.equal(delivered.execution.status, "success");
		assert.equal(delivered.acceptance.status, "accepted", "the parent must accept the verdict without an `attested` fallback dance");
		assert.equal(delivered.acceptance.level, "attested", "no `verify:` commands ⇒ attested");
		assert.equal(getNode(fx.db, node.id)?.phase, "done");
	} finally { fx.cleanup(); }
});

test("#371 e2e solo: the same declaration with verify: reports `verified` to the parent", async () => {
	const commands: string[] = [];
	const fx = fixture({
		verifyRunner: async (command, cwd) => {
			commands.push(`${command} @ ${cwd}`);
			return { code: 0, stdout: "green", stderr: "" };
		},
	});
	try {
		// The shape `index.ts` synthesizes for `subagent({ verify })`: one required
		// criterion carrying the command, so the extension (not the child) runs it
		// at collect time.
		const withVerify = centurion({
			acceptance: {
				level: "attested",
				role: "writer",
				criteria: [{ id: "task-verify", must: "Launcher-supplied verify commands pass", evidence: ["verification-output"], severity: "required", command: "test -f README.md" }],
			},
		});
		const { handle, node } = await launchTeam(fx, { phases: SOLO_MACHINE, agent: withVerify });
		const declared = parsePhaseMachine(fx.supervisor.spawns[0]!.input.env![LEGION_PHASES_ENV]!, LEGION_PHASES_ENV)!;
		const { tools } = toolsFor(fx, node.id, handle.child.worktreePath!, declared);
		await tools.get("legion_phase")!.execute("solo-1", { to: "implementing" });
		await tools.get("legion_phase")!.execute("solo-2", { to: "done" });

		const delivered = await collect(fx, handle.name, '{"ok":true,"reason":"One file, verified by the launcher."}');
		assert.deepEqual(commands, [`test -f README.md @ ${handle.child.worktreePath}`], "the verify command runs in the CHILD's worktree");
		assert.equal(delivered.acceptance.status, "accepted");
		assert.equal(delivered.acceptance.level, "verified");
	} finally { fx.cleanup(); }
});

// ---------------------------------------------------------------------------
// I1 — a declared team is the pipeline that used to be implicit
// ---------------------------------------------------------------------------

test("#371 e2e team: declaring the built-in machine changes nothing (I1)", async () => {
	const fx = fixture();
	const commands: string[] = [];
	try {
		const { handle, node } = await launchTeam(fx, { phases: DEFAULT_PHASE_MACHINE });
		assert.equal(node.phase, "planning");
		const declared = parsePhaseMachine(fx.supervisor.spawns[0]!.input.env![LEGION_PHASES_ENV]!, LEGION_PHASES_ENV)!;
		const runCommand: LegionCommandRunner = async (command) => {
			commands.push(command);
			return { code: 0, stdout: "green", stderr: "" };
		};
		const { tools, messages } = toolsFor(fx, node.id, handle.child.worktreePath!, declared, runCommand);
		const phase = tools.get("legion_phase")!;

		// planning → implementing still needs the contract on disk.
		assert.match(await phase.execute("p1", { to: "implementing" }).then((r) => (r.content ?? []).map((c) => c.text).join("")), /refused/);
		assert.equal(getNode(fx.db, node.id)?.phase, "planning");
		const contractPath = path.join(handle.child.worktreePath!, ".pi-legion", "contract.md");
		mkdirSync(path.dirname(contractPath), { recursive: true });
		writeFileSync(contractPath, [
			"# Frozen test contract",
			"Goal: prove a declared built-in machine is byte-for-byte the old pipeline.",
			"```legion-verify",
			"test -f README.md",
			"```",
		].join("\n"));
		assert.equal(getNode(fx.db, node.id)?.phase, "planning", "nothing advanced on its own");
		await phase.execute("p2", { to: "implementing" });
		assert.equal(getNode(fx.db, node.id)?.phase, "implementing");

		// implementing → reviewing still needs a settled child of THIS team.
		assert.match(await phase.execute("p3", { to: "reviewing" }).then((r) => (r.content ?? []).map((c) => c.text).join("")), /refused/);
		// The team's cast is written straight into the ledger: `requestLegionPhase`
		// judges a transition on node+children facts, and a real dispatch would only
		// add process lifecycle on top of exactly these rows.
		// A settled worker that reported NO verdict: `verdict_ok` needs a settled
		// child whose last turn parses to `{ok:true}`, and "the work is done" is not
		// a review. This is the door `reviewing → verifying` guards (#301).
		const worker = childOf(fx, node.id, "worker", "settled", "Implementation complete; no reviewer verdict is claimed.");
		await phase.execute("p4", { to: "reviewing" });
		assert.equal(getNode(fx.db, node.id)?.phase, "reviewing");

		// reviewing → verifying still needs an `ok:true` verdict from a settled child.
		const premature = (await phase.execute("p5", { to: "verifying" })).content ?? [];
		assert.match(premature.map((item) => item.text).join(""), /refused/);
		assert.equal(getNode(fx.db, node.id)?.phase, "reviewing");
		childOf(fx, node.id, "reviewer", "settled", '{"ok":true,"reason":"clean"}');

		// verifying runs the contract's legion-verify block and completes on its own.
		await phase.execute("p6", { to: "verifying" });
		assert.deepEqual(commands, ["test -f README.md"]);
		assert.equal(getNode(fx.db, node.id)?.phase, "done");
		assert.ok(messages.some((message) => /squash/.test(message)), "the collection prompt still fires on done");
		assert.equal(getNode(fx.db, worker)?.status, "settled", "the settled child is what unlocked reviewing");
		assert.match(readFileSync(path.join(fx.runDir, `${node.name}.legion-verify.log`), "utf8"), /\$ test -f README\.md\nexit: 0/);

		const delivered = await collect(fx, handle.name, '{"ok":true,"reason":"Squad delivered; MR opened."}');
		assert.equal(delivered.acceptance.status, "accepted");
	} finally { fx.cleanup(); }
});

// ---------------------------------------------------------------------------
// I2 — no declaration, no state machine
// ---------------------------------------------------------------------------

test("#371 e2e undeclared: no phase, no legion_phase, no collection prompt (I2)", async () => {
	const fx = fixture();
	try {
		const { handle, node } = await launchTeam(fx);
		assert.equal(node.phase, null, "an undeclared centurion must carry NO phase");
		assert.equal(fx.supervisor.spawns[0]?.input.env?.[LEGION_PHASES_ENV], undefined, "nothing was declared, so nothing travels");

		const { tools, messages } = toolsFor(fx, node.id, handle.child.worktreePath!);
		assert.equal(tools.has("legion_phase"), false, "an undeclared centurion must not receive legion_phase");
		assert.ok(tools.has("legion_mail") && tools.has("legion_tree"), "it is still a normal tree participant");

		const delivered = await collect(fx, handle.name, '{"ok":true,"reason":"One file changed; nothing to lead."}');
		assert.equal(delivered.execution.status, "success");
		assert.equal(delivered.acceptance.status, "accepted");
		assert.equal(getNode(fx.db, node.id)?.phase, null, "a finished undeclared team still has no phase");
		assert.deepEqual(messages, [], "no collection prompt is injected without a machine");
	} finally { fx.cleanup(); }
});

// ---------------------------------------------------------------------------
// G2/G3/G4 + I7 — a refused declaration leaves nothing behind
// ---------------------------------------------------------------------------

test("#371 I7: G2 — a non-root dispatcher may not declare phases, and leaves no artifacts", async () => {
	const fx = fixture();
	try {
		insertNode(fx.db, { id: "root.worker-0", parentId: "root", name: "worker-0", role: "worker", runId: fx.rootRunId, status: "running" });
		const workerOrch = new Orchestrator({
			supervisor: fx.supervisor,
			runDir: fx.runDir,
			cwd: fx.repo,
			maxDepth: 4,
			legion: {
				db: fx.db, dbPath: legionDbPath(fx.runDir), nodeId: "root.worker-0", runId: fx.rootRunId,
				runStore: fx.store, settings: { maxDepth: 4, maxChildrenPerNode: 8, maxActiveNodes: 30 },
				eventBus: createLegionEventBus(),
			},
		});
		await assert.rejects(
			() => workerOrch.launch({ agent: agent("worker"), task: "sneak a machine in", phases: SOLO_MACHINE }),
			(error: unknown) =>
				error instanceof SubagentError &&
				error.code === ErrorCodes.INVALID_PARAMS &&
				error.message === "phases are declared by the root shell only; 'root.worker-0' cannot",
			"a non-root dispatcher must be refused, not silently downgraded",
		);
		assert.equal(fx.supervisor.spawns.length, 0, "a refused dispatch must not spawn anything");
		assert.equal(existsSync(path.join(fx.runDir, "worktrees")), false, "I7: no worktree directory may exist");
		assert.equal(getNode(fx.db, "root.worker-0.worker-0"), null, "I7: no ledger row may exist");
	} finally { fx.cleanup(); }
});

test("#371 I7: G3 — the root may not declare phases for a non-centurion", async () => {
	const fx = fixture();
	try {
		await assert.rejects(
			() => fx.root.launch({ agent: agent("worker"), task: "do it solo", phases: SOLO_MACHINE }),
			(error: unknown) =>
				error instanceof SubagentError &&
				error.code === ErrorCodes.INVALID_PARAMS &&
				error.message === "phases belong to a centurion team; dispatch a worker for solo work",
			"a machine belongs to a team, not to a worker",
		);
		assert.equal(fx.supervisor.spawns.length, 0);
		assert.equal(existsSync(path.join(fx.runDir, "worktrees")), false, "I7: no worktree directory may exist");
		assert.equal(getNode(fx.db, "root.worker-0"), null, "I7: no ledger row may exist");
	} finally { fx.cleanup(); }
});

test("#371 I7: G4 — an inline machine must be valid AND able to reach a terminal phase", async () => {
	const fx = fixture();
	try {
		// (a) a LOOP passes `validatePhaseMachine` and is still refused: no team could
		// ever finish, and finding that out at launch is the whole point.
		await assert.rejects(
			() => fx.root.launch({ agent: centurion(), task: "loop forever", phases: LOOP_MACHINE }),
			(error: unknown) =>
				error instanceof SubagentError &&
				error.code === ErrorCodes.INVALID_PARAMS &&
				/phase machine cannot reach a terminal phase from 'a'/.test(error.message),
			"a machine that can never finish must be refused",
		);
		// (b) the validator's own lines are passed through verbatim, path included.
		await assert.rejects(
			() => fx.root.launch({ agent: centurion(), task: "typo", phases: [{ id: "a", next: [] }, { id: "a", next: [] }] }),
			(error: unknown) =>
				error instanceof SubagentError &&
				error.code === ErrorCodes.INVALID_PARAMS &&
				/phases\[1\]\.id: duplicate phase id 'a'/.test(error.message),
			"validator paths must survive the inline layer",
		);
		// (c) a sibling `start:` is folded into the list form (contract §2's example).
		await assert.rejects(
			() => fx.root.launch({ agent: centurion(), task: "bad start", phases: LOOP_MACHINE, start: "b" }),
			/phase machine cannot reach a terminal phase from 'b'/,
			"the sibling start must be the one the reachability check uses",
		);
		assert.equal(fx.supervisor.spawns.length, 0, "no refused declaration may reach the supervisor");
		assert.equal(existsSync(path.join(fx.runDir, "worktrees")), false, "I7: no worktree directory may exist");
	} finally { fx.cleanup(); }
});
