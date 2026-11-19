/**
 * #411 — the WIRING of the cross-machine live mirror
 * (contract: `.pi-legion/contract.md` §3; the pump itself is `src/runs/live-mirror.ts`).
 *
 * What is pinned here is only what the ORCHESTRATOR owes the pump, because each of
 * these is a way the feature can silently stop working while the pump's own unit
 * tests stay green:
 *
 *   1. a cross-machine launch creates ONE pump, on `child.sessionFile` (the file the
 *      panel, `quiet` and `progressFromSessionFile` already read — never
 *      `remote/<name>.jsonl`, which is a different file written by the read-back);
 *   2. a LOCAL child gets no pump at all (`create` is never even called);
 *   3. a settled collect runs one final sync and then stops the pump;
 *   4. `retire` stops it (no interval outlives the child);
 *   5. the FIRST growth promotes a `launching` record to `working` — the record that
 *      used to stick at `launching` forever, because for a remote child nothing
 *      local ever wrote `working` back;
 *   6. a failing final sync never fails the collect;
 *   7. a throwing `create` never fails the launch.
 *
 * The pump is FAKE throughout (`liveMirror.create`): timing, incremental reads and
 * atomic writes belong to `test/unit/live-mirror.test.ts`. What the fake records is
 * exactly the contract this layer consumes — `start`/`stop`/`syncNow` were called.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { legionDbPath, openLegionDb } from "../../src/legion/db.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import { type LiveMirrorConfig, type LiveMirrorFacts, liveMirrorStatePathFor } from "../../src/runs/live-mirror.ts";
import { Orchestrator, type LiveMirrorRequest, type LiveMirrorSeam } from "../../src/runs/orchestrator.ts";
import type { RemoteReadbackResult, RemoteSessionRequest } from "../../src/runs/remote-artifact.ts";
import type { HostTarget } from "../../src/runs/remote.ts";
import { RunStore } from "../../src/runs/store.ts";
import type { AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import { assistantMsg, sessionHeader, userMsg } from "../helpers/fixtures.ts";

const HOST = "vps";

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "centurion",
		description: "live-mirror wiring role",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a test centurion.",
		source: "user",
		filePath: "/fake/centurion.md",
		worktree: false,
		...overrides,
	};
}

function target(): HostTarget {
	return {
		host: HOST,
		cwd: "/srv/app",
		node: "node",
		piCli: "pi",
		pathMap: [],
		piLegionRoot: "/srv/pi-legion",
		piExtensions: [],
		mirrorRoot: "/srv/.pi-subagents-mirror",
		worktreeRoot: "/srv/.pi-worktrees",
	};
}

function gitRepo(root: string): string {
	const repo = path.join(root, "repo");
	execFileSync("git", ["init", "-q", repo]);
	execFileSync("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"]);
	return repo;
}

/** A transcript whose last turn finished with an assistant message. */
function deliveredTranscript(text: string): string {
	return [sessionHeader({ cwd: "/srv/app" }), userMsg("ship it"), assistantMsg({ text, stopReason: "stop" })].join("\n") + "\n";
}

/**
 * The read-back seam a remote collect needs (without one, `collect` refuses to read
 * a transcript that lives on another machine). It writes the mirror the orchestrator
 * would otherwise have fetched from `hc`.
 */
function readbackWriting(text: string) {
	return async (request: RemoteSessionRequest): Promise<RemoteReadbackResult> => {
		const transcript = deliveredTranscript(text);
		mkdirSync(path.dirname(request.localPath), { recursive: true });
		writeFileSync(request.localPath, transcript);
		const lines = transcript.split("\n").filter((line) => line.trim().length > 0).length;
		return {
			ok: true,
			host: request.host,
			localPath: request.localPath,
			remotePath: `/srv/.pi-subagents-mirror/run/${request.name}/session.jsonl`,
			lines,
			returned: lines,
			truncated: false,
			byteCapped: false,
		};
	};
}

/** Run `body` inside an hc terminal: the only place a cross-machine launch is legal. */
async function insideHcTerminal(body: () => Promise<void>): Promise<void> {
	const socket = process.env.HC_TERMINAL_SOCKET;
	const id = process.env.HC_TERMINAL_ID;
	process.env.HC_TERMINAL_SOCKET = "/tmp/hc-guard/default.sock";
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

/** Bounded pump over a real observable — never a sleep used as synchronisation. */
async function until(pred: () => boolean, label: string, boundMs = 5_000): Promise<void> {
	const deadline = Date.now() + boundMs;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error(`bounded fixture pump expired (${boundMs}ms): ${label}`);
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

/** Everything the fake pump saw, which is the whole contract this layer consumes. */
interface FakePump {
	name: string;
	request: LiveMirrorRequest;
	starts: number;
	stops: number;
	syncs: number;
	/** `syncNow` rejects (the remote went away mid-turn). */
	failSync: boolean;
	facts: LiveMirrorFacts;
}

interface HarnessOptions {
	/** A real ledger + run store, so `run.json` itself can be asserted (test 5). */
	legion?: boolean;
	/** The read-back a remote `collect` requires. */
	readback?: (request: RemoteSessionRequest) => Promise<RemoteReadbackResult>;
	/** `create` itself throws — a launch must survive it (test 7). */
	createThrows?: boolean;
	/** `create` declines (production does this when `remoteDir` is unknowable). */
	createDeclines?: boolean;
	/**
	 * No `create` at all: the PRODUCTION branch builds a real `LiveMirror`. Both fields
	 * are what an operator's settings/env would give it.
	 */
	production?: { env?: Record<string, string | undefined>; config?: Partial<LiveMirrorConfig> };
}

interface Harness {
	root: string;
	supervisor: FakeSupervisor;
	orchestrator: Orchestrator;
	/** Every pump the seam was asked to create, in launch order. */
	pumps: FakePump[];
	/** Every `create` request, including the ones that never became a pump. */
	requests: LiveMirrorRequest[];
	warnings: string[];
	/** Present only for `legion: true`. */
	store?: RunStore;
	runId?: string;
	cleanup: () => void;
}

function harness(options: HarnessOptions = {}): Harness {
	const root = mkdtempSync(path.join(tmpdir(), "live-mirror-orch-"));
	const supervisor = new FakeSupervisor();
	const pumps: FakePump[] = [];
	const requests: LiveMirrorRequest[] = [];
	const warnings: string[] = [];

	let legion: ConstructorParameters<typeof Orchestrator>[0]["legion"];
	let store: RunStore | undefined;
	let runId: string | undefined;
	let closeDb = (): void => {};
	if (options.legion === true) {
		store = new RunStore({ rootDir: path.join(root, ".pi-subagents") });
		const run = store.createRun({ task: "#411 live mirror", cwd: gitRepo(root), maxDepth: 4, nodeId: "root", herdr: { supervisor: "rpc" } });
		runId = run.runId;
		const dbPath = legionDbPath(store.runDir(run.runId));
		const db = openLegionDb(dbPath);
		insertNode(db, { id: "root", parentId: null, name: "root", role: "root", runId: run.runId, status: "running" });
		closeDb = () => db.close();
		legion = {
			db,
			dbPath,
			nodeId: "root",
			runId: run.runId,
			runStore: store,
			settings: { maxDepth: 4, maxChildrenPerNode: 8, maxActiveNodes: 30, verifyCommandTimeoutMs: 5_000 },
			eventBus: createLegionEventBus(),
		};
	}

	const seam: LiveMirrorSeam = options.production
		? {
			warn: (message) => warnings.push(message),
			...(options.production.env ? { env: options.production.env } : {}),
			...(options.production.config ? { config: options.production.config } : {}),
		}
		: {
			config: { enabled: true },
			// An empty env on purpose: the suite's own `PI_LEGION_LIVE_MIRROR` (if an
			// operator exported one) must not turn this fake's pump off.
			env: {},
			warn: (message) => warnings.push(message),
			create: (request) => {
				requests.push(request);
				if (options.createThrows === true) throw new Error("the pump could not be built");
				if (options.createDeclines === true) return undefined;
				const pump: FakePump = {
					name: request.child.name,
					request,
					starts: 0,
					stops: 0,
					syncs: 0,
					failSync: false,
					facts: { localPath: request.localPath, mode: "on", bytes: 0, offset: 0, staleBytes: 0, lastGrowthAt: 0, lastSyncAt: 0 },
				};
				pumps.push(pump);
				return {
					start: () => {
						pump.starts += 1;
					},
					stop: () => {
						pump.stops += 1;
					},
					syncNow: async () => {
						pump.syncs += 1;
						if (pump.failSync) throw new Error("the remote read failed mid-turn");
						return pump.facts;
					},
					facts: () => pump.facts,
				};
			},
		};

	const orchestrator = new Orchestrator({
		supervisor,
		runDir: options.legion === true && store !== undefined && runId !== undefined
			? store.runDir(runId)
			: path.join(root, "run"),
		cwd: path.join(root, "repo"),
		...(legion ? { legion } : {}),
		...(options.readback ? { remoteReadback: options.readback } : {}),
		liveMirror: seam,
	});

	return {
		root,
		supervisor,
		orchestrator,
		pumps,
		requests,
		warnings,
		...(store ? { store } : {}),
		...(runId ? { runId } : {}),
		cleanup: () => {
			closeDb();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** Launch a child that runs on `HOST` (the shape the pump exists for). */
function launchRemote(h: Harness, overrides: Partial<{ name: string }> = {}) {
	return h.orchestrator.launch({ agent: agent(), task: "t", host: HOST, hostTarget: target(), worktree: false, ...overrides });
}

test("1: a cross-machine launch starts one pump on the child's own sessionFile", async () => {
	const h = harness();
	await insideHcTerminal(async () => {
		try {
			const handle = await launchRemote(h);
			assert.equal(handle.child.host, HOST, "the child really is a remote child");
			assert.equal(h.requests.length, 1, "exactly one pump was asked for");
			assert.equal(h.pumps.length, 1);
			const pump = h.pumps[0]!;
			assert.equal(pump.name, handle.name);
			assert.equal(pump.starts, 1, "the pump was started");
			assert.equal(pump.stops, 0);
			// The DESTINATION matters more than anything else in this file: the pump writes
			// the file the panel and `quiet` already read (`child.sessionFile`), not
			// `remote/<name>.jsonl` (that one belongs to the read-back).
			assert.equal(pump.request.localPath, handle.child.sessionFile);
			assert.equal(pump.request.child.name, handle.name);
			assert.equal(h.orchestrator.liveMirrorFacts(handle.name)?.localPath, handle.child.sessionFile);
		} finally {
			h.cleanup();
		}
	});
});

test("2: a LOCAL child gets no pump (create is never called)", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "t", worktree: false });
		assert.equal(handle.child.host, undefined, "a local child has no host");
		assert.equal(h.requests.length, 0, "the seam was not consulted at all");
		assert.equal(h.pumps.length, 0);
		assert.equal(h.orchestrator.liveMirrorFacts(handle.name), undefined);
	} finally {
		h.cleanup();
	}
});

test("3: a settled collect runs one final sync and then stops the pump", async () => {
	const h = harness({ readback: readbackWriting("delivered from the other machine") });
	await insideHcTerminal(async () => {
		try {
			const handle = await launchRemote(h);
			const pump = h.pumps[0]!;
			const collected = await h.orchestrator.collect(handle.name);
			assert.equal(collected.execution.status, "success");
			assert.equal(collected.output, "delivered from the other machine");
			assert.ok(pump.syncs >= 1, "the settle performed a final sync");
			assert.equal(pump.stops, 1, "and the pump is retired with it");
			assert.equal(h.orchestrator.liveMirrorFacts(handle.name), undefined, "a stopped pump is no longer reported");
		} finally {
			h.cleanup();
		}
	});
});

test("4: retire stops the pump", async () => {
	const h = harness();
	await insideHcTerminal(async () => {
		try {
			const handle = await launchRemote(h);
			const pump = h.pumps[0]!;
			assert.equal(pump.starts, 1);
			await h.orchestrator.retire(handle.name);
			assert.equal(pump.stops, 1, "a retired child has no transcript left to copy");
			assert.equal(h.orchestrator.liveMirrorFacts(handle.name), undefined);
		} finally {
			h.cleanup();
		}
	});
});

test("5: the first growth promotes a launching record to working (run.json + memory)", async () => {
	const h = harness({ legion: true });
	const store = h.store!;
	const runId = h.runId!;
	const stateOf = (name: string): string | undefined => store.readRun(runId)?.children.find((child) => child.name === name)?.state;
	await insideHcTerminal(async () => {
		try {
			const handle = await launchRemote(h);
			const pump = h.pumps[0]!;
			// The defect this pins: `persistParentReservation` writes `launching` and, for a
			// cross-machine child, nothing ever wrote `working` back.
			assert.equal(stateOf(handle.name), "launching");
			pump.request.onGrowth();
			await until(() => stateOf(handle.name) === "working", "the growth must promote the persisted record");
			assert.equal(h.orchestrator.childrenSnapshot().find((child) => child.name === handle.name)?.state, "working", "and the in-memory record with it");
			// A second growth of the same child must not rewrite anything (it is bookkeeping,
			// not a state the record may flap).
			pump.request.onGrowth();
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(stateOf(handle.name), "working");
			assert.deepEqual(h.warnings, [], "a promotion never warns");
		} finally {
			h.cleanup();
		}
	});
});

test("6: a failing final sync never fails the collect", async () => {
	const h = harness({ readback: readbackWriting("delivered anyway") });
	await insideHcTerminal(async () => {
		try {
			const handle = await launchRemote(h);
			h.pumps[0]!.failSync = true;
			const collected = await h.orchestrator.collect(handle.name);
			assert.equal(collected.execution.status, "success", "the child's turn is not the pump's problem");
			assert.equal(collected.output, "delivered anyway");
			assert.ok(h.pumps[0]!.syncs >= 1, "the final sync really was attempted");
			assert.ok(
				h.warnings.some((line) => line.includes("final sync")),
				`one warning must name the failure, got: ${JSON.stringify(h.warnings)}`,
			);
			assert.equal(h.pumps[0]!.stops, 1, "and the pump is still stopped");
		} finally {
			h.cleanup();
		}
	});
});

test("7: a throwing create never fails the launch (one warning, no pump)", async () => {
	const h = harness({ createThrows: true });
	await insideHcTerminal(async () => {
		try {
			const handle = await launchRemote(h);
			assert.equal(handle.child.host, HOST, "the launch succeeded regardless");
			assert.equal(h.requests.length, 1, "the seam was tried");
			assert.equal(h.pumps.length, 0);
			assert.equal(h.orchestrator.liveMirrorFacts(handle.name), undefined);
			assert.equal(h.warnings.length, 1, `exactly one warning, got: ${JSON.stringify(h.warnings)}`);
			assert.match(h.warnings[0]!, /was not started: the pump could not be built/);
			// And the child is usable: the transcript path is still the record's own.
			assert.equal(handle.sessionFile, handle.child.sessionFile);
		} finally {
			h.cleanup();
		}
	});
});

test("8: a declining seam (remoteDir unknowable) starts nothing and warns nothing", async () => {
	const h = harness({ createDeclines: true });
	await insideHcTerminal(async () => {
		try {
			const handle = await launchRemote(h);
			assert.equal(h.requests.length, 1);
			assert.equal(h.pumps.length, 0);
			assert.equal(h.orchestrator.liveMirrorFacts(handle.name), undefined);
			assert.deepEqual(h.warnings, [], "declining is a decision, not a failure");
		} finally {
			h.cleanup();
		}
	});
});

/**
 * The PRODUCTION branch, disabled by the operator: contract §3 wants the `mode:"off"`
 * facts row anyway, because `status` must be able to say `mirror=off` instead of an
 * unexplained silence. A remote-less `LiveMirror` opens no connection at all.
 */
test("9: production, disabled: a mode=off pump still writes its facts row", async () => {
	const h = harness({ production: { env: { PI_LEGION_LIVE_MIRROR: "off" }, config: { intervalMs: 500 } } });
	await insideHcTerminal(async () => {
		try {
			const handle = await launchRemote(h);
			assert.equal(h.orchestrator.liveMirrorFacts(handle.name)?.mode, "off");
			const statePath = liveMirrorStatePathFor(handle.child.sessionFile);
			await until(() => {
				try {
					return JSON.parse(readFileSync(statePath, "utf8")).mode === "off";
				} catch {
					return false;
				}
			}, "the off pump must persist its facts");
			await h.orchestrator.retire(handle.name);
			assert.equal(h.orchestrator.liveMirrorFacts(handle.name), undefined, "retire stops and forgets it");
		} finally {
			h.cleanup();
		}
	});
});

/**
 * Production, enabled, but the record has no `remoteDir` (the launch did not report
 * one). `createLiveMirrorRemote` answers `undefined` — the path is unknowable — and
 * guessing it would turn "we do not know where that child writes" into a permanent
 * error row on every tick. So: no pump, nothing started.
 */
test("10: production, enabled but no remoteDir: no pump is built", async () => {
	const h = harness({ production: { env: {}, config: { intervalMs: 500 } } });
	await insideHcTerminal(async () => {
		try {
			const handle = await launchRemote(h);
			assert.equal(handle.child.remoteDir, undefined, "this fake backend reports no mirrored dir");
			assert.equal(h.orchestrator.liveMirrorFacts(handle.name), undefined, "no pump without a remote path");
			assert.deepEqual(h.warnings, [], "an unknowable path is not a failure");
		} finally {
			h.cleanup();
		}
	});
});
