/**
 * #409 — every launched terminal must have a PARENT, and the parent must be an
 * address the TARGET core can resolve.
 *
 * The issue was measured from `hc ls --all`: a cross-machine child created by
 * legion had `parent: null` and no `where` column, so "whose terminal/directory
 * is this?" had no answer and the Herdr app could not place it anywhere. The
 * cause was in the wire shape, not in the display: `terminal.run` was sent with
 * no `parent` at all, and `hc run --parent` accepts no universal spelling —
 * `t1t` (the caller's id, another core) answers `no terminal "t1t"`, and
 * `hw-nj/t5j` answers `unknown machine "hw-nj"` (the SENDING core resolves the
 * prefix). The one form that works is a TARGET-LOCAL address, which is what
 * `parent-anchor.ts` exists to produce and this file pins:
 *
 *   1. LOCAL launch      → the caller's own terminal (`HC_TERMINAL_ID`), which IS
 *                          an address of the core that receives the request;
 *   2. REMOTE launch     → that machine's `lgl-anchor` (created on the
 *                          default-parent path, reused afterwards);
 *   3. no address at all → NOT a silent omission: the record/receipt/status say
 *                          `parent=absent(<reason>)`;
 *   4. `run.json` holds the chain child terminal → parent terminal → run.
 *
 * Part A covers the pure rules, part B the wire shape through the real
 * `TerminalSupervisor` with a scripted client, part C the persisted record
 * through the real `Orchestrator` + run store (the fixture shape #423's tests
 * use for the same reason: run.json is the file a reader actually sees).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { launchNoticeLines } from "../../src/runs/orchestrator.ts";
import { Orchestrator, type OrchestratorLegionContext } from "../../src/runs/orchestrator.ts";
import {
	ANCHOR_TERMINAL_NAME,
	LEGION_ANCHOR_LABEL,
	anchorLocalAddress,
	parentChain,
	parentLine,
	parentNoticeLines,
} from "../../src/runs/parent-anchor.ts";
import { thisPackageRoot, type HostTarget } from "../../src/runs/remote.ts";
import { RunStore } from "../../src/runs/store.ts";
import { legionDbPath, openLegionDb } from "../../src/legion/db.ts";
import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import type { HcClient, HcMethod } from "../../src/hc/client.ts";
import { TerminalSupervisor } from "../../src/supervisor/terminal-supervisor.ts";
import type { SpawnInput } from "../../src/supervisor/types.ts";
import type { AgentConfig, ChildRecord } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

// ── part A: the pure rules ─────────────────────────────────────────────────

test("#409: the chain is child terminal → parent terminal → run, and a broken one is not `ok`", () => {
	// The cross-machine shape: the core holds `host/name` for the child, the launch
	// named the machine's anchor as its parent, and the record names the run.
	const chain = parentChain({
		host: "hw-nj",
		remoteTerminal: "hw-nj/lgl-r-4f-worker-0",
		parentTerminal: "t5j",
		parentRunId: "r-4f2a91c0",
	});
	assert.deepEqual(chain, {
		ok: true,
		childTerminal: "hw-nj/lgl-r-4f-worker-0",
		parentTerminal: "t5j",
		parentRunId: "r-4f2a91c0",
	});

	// Missing the parent address: the launch could not name one. An EXPLAINED
	// absence is still an absence — `ok` must not read as "connected".
	const absent = parentChain({ host: "hw-nj", remoteTerminal: "hw-nj/lgl-x", parentAbsent: "no anchor on hw-nj (refused)" });
	assert.equal(absent.ok, false);
	assert.equal(absent.parentTerminal, undefined);
	assert.equal(absent.childTerminal, "hw-nj/lgl-x");

	// A legacy record (before #409) has neither field: same answer, no invention.
	assert.equal(parentChain({ host: "hw-nj", remoteTerminal: "hw-nj/lgl-y" }).ok, false);
	// Blank strings are "no fact", never a name.
	assert.equal(parentChain({ parentTerminal: "   ", parentRunId: "r-1" }).ok, false);
});

test("#409: `parent=` and `parent=absent(...)` are the ONE spelling every surface prints", () => {
	assert.equal(parentLine({ parentTerminal: "t77" }), "parent=t77");
	assert.equal(parentLine({ parentAbsent: "no caller terminal (HC_TERMINAL_ID is unset)" }), "parent=absent(no caller terminal (HC_TERMINAL_ID is unset))");
	// Neither fact known: say nothing rather than invent an absence.
	assert.equal(parentLine({}), undefined);
	// The reason wins when both are somehow present: an absence with a reason is
	// the more honest sentence.
	assert.equal(parentLine({ parentTerminal: "t1", parentAbsent: "anchor gone" }), "parent=absent(anchor gone)");
});

test("#409 req 2: the receipt shows the parent it used, and NEVER omits a missing one", () => {
	// A cross-machine launch prints the target-local address (the proof the chain is
	// connected on that machine).
	assert.deepEqual(parentNoticeLines("worker-0", { host: "hw-nj", parentTerminal: "t5j" }), [
		"  parent=t5j (target-local address on hw-nj)",
	]);
	// A local launch prints nothing: its parent is the terminal the reader is in.
	assert.deepEqual(parentNoticeLines("worker-0", { parentTerminal: "t77" }), []);
	// An absent parent is a WARNING line, with the cause — the requirement is that it
	// cannot look like a launch that simply had nothing to say.
	assert.deepEqual(parentNoticeLines("worker-0", { parentAbsent: "no anchor on hw-nj (spawn_failed)" }), [
		"  ⚠ worker-0: parent=absent(no anchor on hw-nj (spawn_failed))",
	]);
	// And the shared renderer (the same one the `▶` line and the queued notice use).
	assert.deepEqual(
		launchNoticeLines("worker-0", { warnings: ["skipped 1 inherited extension"], parentAbsent: "no HC_TERMINAL_ID" }),
		["  ⚠ worker-0: skipped 1 inherited extension", "  ⚠ worker-0: parent=absent(no HC_TERMINAL_ID)"],
	);
});

test("#409: the anchor's target-local address is the part after the machine prefix", () => {
	// What `terminal.run{on}` answers on a real core (`loopback409/t1`).
	assert.equal(anchorLocalAddress({ address: "hw-nj/t5j", name: "lgl-anchor" }, "hw-nj"), "t5j");
	// A core that answers the bare local address is already local.
	assert.equal(anchorLocalAddress({ address: "t5j", name: "lgl-anchor" }, "hw-nj"), "t5j");
	// Another machine's address is NOT usable as a parent here; the name is the fallback.
	assert.equal(anchorLocalAddress({ address: "vps/t9", name: "lgl-anchor" }, "hw-nj"), "lgl-anchor");
	assert.equal(anchorLocalAddress({ name: "lgl-anchor" }, "hw-nj"), "lgl-anchor");
	assert.equal(anchorLocalAddress({}, "hw-nj"), undefined);
});

// ── part B: the wire shape through the real supervisor ─────────────────────

// Hermetic: the host's discovered extensions are absolute paths from whatever
// machine runs the suite, and a remote launch REFUSES an argv path it cannot map.
// Turning inheritance off leaves exactly one absolute entry — this package's own —
// which the fixture maps through `pathMap` (the same setup `cross-machine-params`
// uses; there is no file system on the "other machine" here).
process.env.PI_LEGION_CHILD_INHERIT_EXTENSIONS = "0";

const HOST = "vps";
const TERMINAL_ID = "t1k";
const REMOTE_CWD = "/srv/remote/work";
const REMOTE_LEGION_ROOT = `${REMOTE_CWD}/.pi-legion`;

type Params = Record<string, unknown>;

interface Call {
	method: HcMethod;
	params: Params;
}

/** A protocol client that records calls and answers through per-method handlers. */
class ScriptedClient implements HcClient {
	readonly calls: Call[] = [];
	private readonly handlers = new Map<string, (params: Params) => unknown>();

	on(method: HcMethod, handler: (params: Params) => unknown): this {
		this.handlers.set(method, handler);
		return this;
	}

	async start(): Promise<void> {
		/* nothing to hand shake */
	}

	async request<T = unknown>(method: HcMethod, params: Params = {}): Promise<T> {
		this.calls.push({ method, params });
		const handler = this.handlers.get(method);
		if (!handler) throw new Error(`scripted hc client: no handler for ${method}`);
		return (await handler(params)) as T;
	}

	close(): void {
		/* nothing to tear down */
	}

	paramsFor(method: HcMethod): Params[] {
		return this.calls.filter((call) => call.method === method).map((call) => call.params);
	}

	/** The child's own `terminal.run` — the machine's anchor comes first (#409). */
	childRuns(): Params[] {
		return this.paramsFor("terminal.run").filter((params) => params.name !== ANCHOR_TERMINAL_NAME);
	}
}

function hostTarget(): HostTarget {
	return {
		host: HOST,
		cwd: REMOTE_CWD,
		node: "node",
		piCli: "pi",
		pathMap: [{ from: thisPackageRoot(), to: REMOTE_LEGION_ROOT }],
		piLegionRoot: REMOTE_LEGION_ROOT,
		piExtensions: [],
		mirrorRoot: path.posix.join(path.posix.dirname(REMOTE_CWD), ".pi-subagents-mirror"),
		worktreeRoot: path.posix.join(path.posix.dirname(REMOTE_CWD), ".pi-worktrees"),
		// A `worker` may cross only when the target says so (xm-dispatch D4); these
		// cases are about the parent, so the operator has allowed it.
		allowRoles: ["centurion", "worker"],
	};
}

function agent(): AgentConfig {
	return {
		name: "centurion",
		description: "spawn parent test role",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a test centurion.",
		source: "user",
		filePath: "/fake/centurion.md",
		worktree: true,
	};
}

function spawnInput(root: string, overrides: Partial<SpawnInput> = {}): SpawnInput {
	return {
		name: "root.centurion-0",
		task: "Implement the slice.",
		agent: agent(),
		sessionFile: path.join(root, "session.jsonl"),
		tempDir: root,
		cwd: root,
		env: { PI_LEGION_DB: path.join(root, "legion.db"), PI_LEGION_NODE_ID: "root.centurion-0" },
		cliPath: "/fake/pi/dist/cli.js",
		...overrides,
	};
}

interface Harness {
	client: ScriptedClient;
	supervisor: TerminalSupervisor;
	root: string;
	cleanup(): void;
}

/**
 * The fake core's default answers: setup probes succeed, a terminal starts, and
 * `terminal.run` answers per NAME so the anchor and the child are distinguishable.
 */
function harness(options: {
	env: NodeJS.ProcessEnv;
	/** Terminal names whose `terminal.run` must fail (e.g. an anchor a core refuses). */
	refuse?: (name: string) => Error | undefined;
	/** Addresses `terminal.get` reports as live (the anchor-reuse path). */
	liveTerminals?: string[];
}): Harness {
	const root = mkdtempSync(path.join(tmpdir(), "spawn-parent-anchor-"));
	const client = new ScriptedClient();
	const seq = { n: 0 };
	client.on("terminal.get", (params) => {
		const terminal = String(params.terminal);
		if (options.liveTerminals?.includes(terminal)) {
			return { address: terminal, name: ANCHOR_TERMINAL_NAME, state: "live", turn: 0, status: { state: "idle" }, labels: { [LEGION_ANCHOR_LABEL]: HOST } };
		}
		throw Object.assign(new Error(`no terminal "${terminal}"`), { code: -32000, data: { kind: "not_found" } });
	});
	client.on("terminal.run", (params) => {
		const name = String(params.name);
		const refusal = options.refuse?.(name);
		if (refusal !== undefined) throw refusal;
		seq.n += 1;
		return {
			address: `${HOST}/t${seq.n}`,
			name,
			state: "live",
			turn: 0,
			status: { state: "idle" },
			pid: 4242,
		};
	});
	client.on("terminal.send", () => ({ turn: 1, started: true }));
	client.on("terminal.interrupt", () => ({ key: "esc", outcome: "stopped" }));
	client.on("terminal.kill", () => ({ address: "t1", state: "finished" }));
	client.on("terminal.rm", () => ({ removed: "t1" }));
	client.on("machine.exec", () => ({ code: 0, ms: 1, signal: null, stdout: "", stderr: "", truncated: false, timed_out: false }));
	client.on("file.write", (params) => ({ path: params.path, bytes: String(params.data ?? "").length }));
	const supervisor = new TerminalSupervisor({
		clientFactory: () => client,
		env: options.env,
		pollIntervalMs: 5,
		// These cases pin the wire SHAPE; the start-up gate is `remote-child-fate`'s job.
		remoteStartupConfirmMs: 0,
	});
	return { client, supervisor, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A process that IS an hc terminal (has the two env markers). */
function callerEnv(): NodeJS.ProcessEnv {
	return { PATH: "/parent/bin:/usr/bin", HOME: "/home/fykzq", HC_TERMINAL_SOCKET: "/tmp/hc-test/default.sock", HC_TERMINAL_ID: TERMINAL_ID };
}

/** A headless process: `hc exec`, cron, a bare `pi` — no terminal to name. */
function headlessEnv(): NodeJS.ProcessEnv {
	return { PATH: "/parent/bin:/usr/bin", HOME: "/home/fykzq" };
}

test("#409 req 1: a cross-machine spawn sends a TARGET-LOCAL parent (the anchor), not this machine's id", async () => {
	const h = harness({ env: callerEnv() });
	try {
		const handle = await h.supervisor.spawnChild(spawnInput(h.root, { host: HOST, hostTarget: hostTarget() }));
		const runs = h.client.paramsFor("terminal.run");
		// 1. The anchor is created FIRST, on the default-parent path: `on` that machine,
		//    the label that says what it is, and the caller forwarded (no explicit
		//    parent — nothing over there is ours yet).
		assert.equal(runs.length, 2, `anchor + child: ${JSON.stringify(runs)}`);
		const anchor = runs[0]!;
		assert.equal(anchor.name, ANCHOR_TERMINAL_NAME);
		assert.equal(anchor.on, HOST);
		assert.deepEqual(anchor.labels, { [LEGION_ANCHOR_LABEL]: HOST });
		assert.equal(anchor.caller, TERMINAL_ID);
		assert.equal("parent" in anchor, false, "the anchor has no local parent to name yet");
		assert.deepEqual(anchor.argv, [], "the anchor is that machine's own shell");
		// 2. The child hangs from the anchor's TARGET-LOCAL address. `t1` is what the
		//    fake core answered for `vps/lgl-anchor`; `t1k` (the caller) or
		//    `vps/t1k` (a qualified spelling) are the two forms the real core REFUSES.
		const [child] = h.client.childRuns();
		assert.equal(child!.parent, "t1");
		assert.notEqual(child!.parent, TERMINAL_ID);
		assert.notEqual(child!.parent, `${HOST}/${TERMINAL_ID}`);
		// The child of a remote launch still carries no `caller` (constraint 5).
		assert.equal("caller" in child!, false);
		assert.equal(handle.parentTerminal, "t1");
		assert.equal(handle.parentAbsent, undefined);
	} finally {
		h.cleanup();
	}
});

test("#409: a second launch to the same machine REUSES the live anchor (one terminal per machine)", async () => {
	const h = harness({ env: callerEnv(), liveTerminals: [`${HOST}/${ANCHOR_TERMINAL_NAME}`] });
	try {
		await h.supervisor.spawnChild(spawnInput(h.root, { host: HOST, hostTarget: hostTarget() }));
		const runs = h.client.paramsFor("terminal.run");
		assert.equal(runs.length, 1, "no second anchor may be created");
		assert.equal(runs[0]!.parent, ANCHOR_TERMINAL_NAME);
		// The probe asked for the qualified address: a bare name is unique per core, not
		// across machines (contract D7).
		assert.deepEqual(h.client.paramsFor("terminal.get").map((params) => params.terminal), [`${HOST}/${ANCHOR_TERMINAL_NAME}`]);
	} finally {
		h.cleanup();
	}
});

test("#409 req 2: an anchor the machine refuses does not hide — the launch continues and says `parent=absent`", async () => {
	const refusal = new Error('terminal name taken: lgl-anchor');
	const h = harness({ env: callerEnv(), refuse: (name) => (name === ANCHOR_TERMINAL_NAME ? refusal : undefined) });
	try {
		const handle = await h.supervisor.spawnChild(spawnInput(h.root, { host: HOST, hostTarget: hostTarget() }));
		const [child] = h.client.childRuns();
		assert.ok(child, "the child is still launched — a missing parent is never a refusal");
		assert.equal("parent" in child, false, "no invented address: the request says nothing rather than something untrue");
		assert.match(String(handle.parentAbsent), new RegExp(`no anchor on ${HOST}`));
		assert.match(String(handle.parentAbsent), /terminal name taken: lgl-anchor/);
		assert.deepEqual(parentNoticeLines(handle.name, { host: HOST, parentAbsent: handle.parentAbsent }), [
			`  ⚠ root.centurion-0: parent=absent(no anchor on ${HOST} (terminal name taken: lgl-anchor))`,
		]);
	} finally {
		h.cleanup();
	}
});

test("#409 req 1: a LOCAL spawn sends its own terminal as the parent, in this core's namespace", async () => {
	const h = harness({ env: callerEnv() });
	try {
		const handle = await h.supervisor.spawnChild(spawnInput(h.root));
		const [run] = h.client.childRuns();
		assert.equal(run!.parent, TERMINAL_ID);
		assert.equal(run!.caller, TERMINAL_ID);
		assert.equal(handle.parentTerminal, TERMINAL_ID);
	} finally {
		h.cleanup();
	}
});

test("#409 req 2: a headless process names no parent — and never pretends it did", async () => {
	const h = harness({ env: headlessEnv() });
	try {
		const handle = await h.supervisor.spawnChild(spawnInput(h.root));
		const [run] = h.client.childRuns();
		assert.equal("parent" in run!, false);
		assert.equal("caller" in run!, false);
		assert.match(String(handle.parentAbsent), /HC_TERMINAL_ID/);
		// The one sentence both renderers use.
		assert.equal(parentLine({ parentAbsent: handle.parentAbsent }), `parent=absent(${handle.parentAbsent})`);
	} finally {
		h.cleanup();
	}
});

// ── part C: the persisted chain ────────────────────────────────────────────

function recordFixture(): {
	rootDir: string;
	runStore: RunStore;
	rootRunId: string;
	context: OrchestratorLegionContext;
	orchestrator: (supervisor: FakeSupervisor) => Orchestrator;
	child: (name: string) => ChildRecord | undefined;
	cleanup: () => void;
} {
	const rootDir = mkdtempSync(path.join(tmpdir(), "spawn-parent-record-"));
	const runStore = new RunStore({ rootDir: path.join(rootDir, ".pi-subagents") });
	const rootRun = runStore.createRun({ task: "root task", cwd: rootDir, nodeId: "root", maxDepth: 4, herdr: { supervisor: "terminal" } });
	const db = openLegionDb(path.resolve(legionDbPath(runStore.runDir(rootRun.runId))));
	insertNode(db, { parentId: null, name: "root", role: "root", runId: rootRun.runId, status: "running" });
	const context: OrchestratorLegionContext = {
		db,
		dbPath: path.resolve(legionDbPath(runStore.runDir(rootRun.runId))),
		nodeId: "root",
		parentNodeId: null,
		parentRunId: null,
		runId: rootRun.runId,
		runStore,
		settings: { maxDepth: 4, maxChildrenPerNode: 8, maxActiveNodes: 30 },
		eventBus: createLegionEventBus(),
	};
	return {
		rootDir,
		runStore,
		rootRunId: rootRun.runId,
		context,
		orchestrator: (supervisor) =>
			new Orchestrator({ supervisor, runDir: runStore.runDir(rootRun.runId), cwd: rootDir, maxDepth: 4, legion: context }),
		child: (name) => runStore.findChild(rootRun.runId, name) ?? undefined,
		cleanup: () => {
			db.close();
			rmSync(rootDir, { recursive: true, force: true });
		},
	};
}

function workerAgent(): AgentConfig {
	return {
		name: "worker",
		description: "spawn parent record role",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a test worker.",
		source: "user",
		filePath: "/fake/worker.md",
		worktree: false,
	};
}

async function insideHcTerminal(body: () => Promise<void>): Promise<void> {
	const socket = process.env.HC_TERMINAL_SOCKET;
	const id = process.env.HC_TERMINAL_ID;
	process.env.HC_TERMINAL_SOCKET = "/tmp/hc-spawn-parent/default.sock";
	process.env.HC_TERMINAL_ID = "t1k";
	try {
		await body();
	} finally {
		if (socket === undefined) delete process.env.HC_TERMINAL_SOCKET;
		else process.env.HC_TERMINAL_SOCKET = socket;
		if (id === undefined) delete process.env.HC_TERMINAL_ID;
		else process.env.HC_TERMINAL_ID = id;
	}
}

test("#409 req 3: run.json carries child terminal → parent terminal → run (reverse-lookupable)", async () => {
	const fx = recordFixture();
	try {
		const supervisor = new FakeSupervisor({
			handleExtras: { remoteTerminal: "vps/lgl-rx-worker-0", parentTerminal: "t7" },
		});
		const orchestrator = fx.orchestrator(supervisor);
		await insideHcTerminal(async () => {
			await orchestrator.launch({ agent: workerAgent(), task: "do it", name: "worker-0", host: HOST, hostTarget: hostTarget() });
		});
		const record = fx.child("worker-0");
		assert.ok(record, "the child must be persisted");
		assert.equal(record.parentTerminal, "t7", "the address the target core was told is the parent");
		assert.equal(record.parentRunId, fx.rootRunId, "the run that owns the chain");
		assert.equal(record.remoteTerminal, "vps/lgl-rx-worker-0", "the child's own address");
		// The reverse walk this is for: a terminal found in `hc ls` → whose is it?
		assert.deepEqual(parentChain(record), {
			ok: true,
			childTerminal: "vps/lgl-rx-worker-0",
			parentTerminal: "t7",
			parentRunId: fx.rootRunId,
		});
	} finally {
		fx.cleanup();
	}
});

test("#409 req 2 + 3: an unparented launch persists the REASON and prints it in the receipt", async () => {
	const fx = recordFixture();
	try {
		const supervisor = new FakeSupervisor({ handleExtras: { parentAbsent: "no anchor on vps (spawn_failed)" } });
		const orchestrator = fx.orchestrator(supervisor);
		let handle: Awaited<ReturnType<Orchestrator["launch"]>> | undefined;
		await insideHcTerminal(async () => {
			handle = await orchestrator.launch({ agent: workerAgent(), task: "do it", name: "worker-0", host: HOST, hostTarget: hostTarget() });
		});
		const record = fx.child("worker-0");
		assert.ok(record, "the child must be persisted");
		assert.equal(record.parentAbsent, "no anchor on vps (spawn_failed)");
		assert.equal(record.parentTerminal, undefined, "no address may be invented beside a reason");
		// The receipt used by `subagent(...)` and the queued notice (`launchNoticeLines`),
		// fed exactly the way `index.ts` feeds it.
		const receipt = launchNoticeLines(handle!.name, {
			...handle!,
			host: handle!.child.host,
			parentTerminal: handle!.child.parentTerminal,
			parentAbsent: handle!.child.parentAbsent,
		});
		assert.deepEqual(receipt, ["  ⚠ worker-0: parent=absent(no anchor on vps (spawn_failed))"]);
	} finally {
		fx.cleanup();
	}
});

test("#409: a local child records the parent run it belongs to as well", async () => {
	const fx = recordFixture();
	try {
		const supervisor = new FakeSupervisor({ handleExtras: { parentTerminal: "t1k" } });
		const orchestrator = fx.orchestrator(supervisor);
		await orchestrator.launch({ agent: workerAgent(), task: "do it", name: "worker-0" });
		const record = fx.child("worker-0");
		assert.ok(record);
		assert.equal(record.parentTerminal, "t1k");
		assert.equal(record.parentRunId, fx.rootRunId);
		assert.equal(parentChain(record).ok, true);
	} finally {
		fx.cleanup();
	}
});
