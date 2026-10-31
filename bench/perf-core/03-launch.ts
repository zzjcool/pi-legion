/**
 * perf-core bench 3 — where does a single `launch()` spend its fixed overhead?
 *
 * Attribution is by ablation plus isolated micro-measures, all driving the
 * production modules:
 *   - legion path  vs  no-legion path        → ledger + run.json cost
 *   - git cwd      vs  non-git cwd           → the synchronous `git rev-parse` probe
 *   - no-op supervisor vs FakeSupervisor     → the supervisor's own spawn cost
 * Each isolated unit is also timed on its own so the parts sum to the whole.
 *
 * Run: node --experimental-strip-types bench/perf-core/03-launch.ts
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { openLegionDb } from "../../src/legion/db.ts";
import { insertNode, updateNode, heartbeatNode } from "../../src/legion/nodes.ts";
import { appendEvent } from "../../src/legion/events.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { RunStore } from "../../src/runs/store.ts";
import { createChildWorktree, isInsideChildWorktree } from "../../src/runs/worktree.ts";
import { preCreateSessionFile } from "../../src/runs/orchestrator.ts";
import type { AgentConfig } from "../../src/shared/types.ts";
import type { ChildHandle, LegionSupervisor, SpawnInput, SettleResult, AbortOutcome, SteerDisposition } from "../../src/supervisor/types.ts";
import { FakeSupervisor } from "../../test/helpers/fake-supervisor.ts";

const REPS = 3;
const LAUNCHES = 15;

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? (s[mid] as number) : (((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

function agent(): AgentConfig {
	return {
		name: "worker",
		description: "bench agent",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a bench agent.",
		source: "user",
		filePath: "/fake/worker.md",
	};
}

/** Supervisor that does the minimum a launch needs: an alive handle, no I/O. */
class NoopSupervisor implements LegionSupervisor {
	readonly uiProxy = new FakeSupervisor().uiProxy;
	private readonly alive = new Set<string>();
	async spawnChild(input: SpawnInput): Promise<ChildHandle> {
		fs.writeFileSync(input.sessionFile, "");
		this.alive.add(input.name);
		return { name: input.name, sessionFile: input.sessionFile, spawnMode: "inprocess" } as ChildHandle;
	}
	async prompt(): Promise<void> {}
	async steer(): Promise<SteerDisposition> { return "queued"; }
	async followUp(): Promise<void> {}
	async abort(): Promise<AbortOutcome> { return { status: "no-turn" } as AbortOutcome; }
	async waitSettled(): Promise<SettleResult> { return { settled: true, abnormal: false }; }
	async retire(): Promise<void> {}
	isAlive(name: string): boolean { return this.alive.has(name); }
	onEvent(): () => void { return () => {}; }
	stats(): never { throw new Error("unused"); }
	usage(): null { return null; }
}

interface Env {
	dir: string;
	runsRoot: string;
	store: RunStore;
	db: ReturnType<typeof openLegionDb>;
	close(): void;
}

function makeEnv(): Env {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-core-launch-"));
	const runsRoot = path.join(dir, ".pi-subagents");
	fs.mkdirSync(path.join(runsRoot, "runs"), { recursive: true });
	const db = openLegionDb(path.join(runsRoot, "legion.db"));
	insertNode(db, { id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0, status: "running" });
	const store = new RunStore({ rootDir: runsRoot });
	return {
		dir,
		runsRoot,
		store,
		db,
		close() {
			try { db.close(); } catch { /* ignore */ }
			try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
		},
	};
}

function makeOrchestrator(env: Env, opts: { legion: boolean; supervisor: LegionSupervisor; cwd: string; index: number }): { orchestrator: Orchestrator; runId: string } {
	const run = env.store.createRun({ task: "bench", cwd: opts.cwd });
	return {
		runId: run.runId,
		orchestrator: new Orchestrator({
			supervisor: opts.supervisor,
			runDir: env.store.runDir(run.runId),
			cwd: opts.cwd,
			...(opts.legion ? { legion: { db: env.db, dbPath: path.join(env.runsRoot, "legion.db"), nodeId: "root", runId: run.runId, runStore: env.store } } : {}),
		}),
	};
}

async function timeLaunches(opts: { legion: boolean; supervisor: () => LegionSupervisor; cwd: string }, reps = REPS): Promise<number[]> {
	const out: number[] = [];
	for (let r = 0; r < reps; r += 1) {
		const env = makeEnv();
		try {
			const { orchestrator } = makeOrchestrator(env, { legion: opts.legion, supervisor: opts.supervisor(), cwd: opts.cwd, index: r });
			const t0 = process.hrtime.bigint();
			for (let i = 0; i < LAUNCHES; i += 1) {
				await orchestrator.launch({ agent: agent(), task: `do thing ${i}`, name: `w${i}` });
			}
			out.push(Number(process.hrtime.bigint() - t0) / 1e6 / LAUNCHES);
		} finally {
			env.close();
		}
	}
	return out;
}

function micro(fn: () => void, n: number): number {
	fn(); // warm
	const samples: number[] = [];
	for (let r = 0; r < 3; r += 1) {
		const t0 = process.hrtime.bigint();
		for (let i = 0; i < n; i += 1) fn();
		samples.push(Number(process.hrtime.bigint() - t0) / 1e6 / n);
	}
	return median(samples);
}

const repoCwd = path.resolve(import.meta.dirname, "../..");

// A tiny real repo so `git worktree add` runs for real (not stubbed).
const smallRepo = fs.mkdtempSync(path.join(os.tmpdir(), "perf-core-repo-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: smallRepo });
fs.writeFileSync(path.join(smallRepo, "a.txt"), "hello\n");
execFileSync("git", ["add", "."], { cwd: smallRepo });
execFileSync("git", ["-c", "user.email=b@b", "-c", "user.name=b", "commit", "-qm", "init"], { cwd: smallRepo });
const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "perf-core-nogit-"));

const result: Record<string, unknown> = {};

try {
	// --- end-to-end ablation
	const noop = (): LegionSupervisor => new NoopSupervisor();
	const legionGit = await timeLaunches({ legion: true, supervisor: noop, cwd: repoCwd });
	const noLegionGit = await timeLaunches({ legion: false, supervisor: noop, cwd: repoCwd });
	const legionNonGit = await timeLaunches({ legion: true, supervisor: noop, cwd: nonGit });
	const fakeLegionGit = await timeLaunches({ legion: true, supervisor: () => new FakeSupervisor({ autoSettle: { text: "done", stopReason: "stop" } }), cwd: repoCwd });

	// --- isolated units
	const env = makeEnv();
	try {
		let n = 0;
		const sessionDir = path.join(env.dir, "sessions");
		const units = {
			isInsideChildWorktree_gitRepo: micro(() => { isInsideChildWorktree(repoCwd); }, 10),
			isInsideChildWorktree_nonGit: micro(() => { isInsideChildWorktree(nonGit); }, 10),
			preCreateSessionFile: micro(() => { preCreateSessionFile(path.join(sessionDir, `s${n += 1}.jsonl`)); }, 200),
			insertNode: micro(() => { const i = (n += 1); insertNode(env.db, { id: `root.x${i}`, parentId: "root", name: `x${i}`, role: "worker", kind: "pi", depth: 1, status: "running" }); }, 100),
			updateNode: micro(() => { updateNode(env.db, "root", { status: "running" }); }, 200),
			appendEvent: micro(() => { appendEvent(env.db, "root", "node_launched"); }, 500),
			heartbeatNode: micro(() => { heartbeatNode(env.db, "root", () => Date.now()); }, 500),
			runStore_createRun: micro(() => { env.store.createRun({ task: `t${n += 1}`, cwd: repoCwd }); }, 50),
		};
		// Full `git worktree add` on a 1-commit repo: the floor cost of worktree isolation.
		const wt: number[] = [];
		for (let i = 0; i < 5; i += 1) {
			const t0 = process.hrtime.bigint();
			createChildWorktree({ repoCwd: smallRepo, runDir: path.join(smallRepo, ".pi-subagents", "runs", `r${i}`), name: `bench-${i}` });
			wt.push(Number(process.hrtime.bigint() - t0) / 1e6);
		}
		result.units = {
			...Object.fromEntries(Object.entries(units).map(([k, v]) => [k, Number(v.toFixed(3))])),
			git_worktree_add_smallRepo: Number(median(wt).toFixed(1)),
			git_worktree_add_samples: wt.map((x) => Number(x.toFixed(1))),
		};
	} finally {
		env.close();
	}

	result.endToEnd = {
		msPerLaunch: {
			legion_plus_gitCwd_noopSpawn: Number(median(legionGit).toFixed(2)),
			noLegion_gitCwd_noopSpawn: Number(median(noLegionGit).toFixed(2)),
			legion_nonGitCwd_noopSpawn: Number(median(legionNonGit).toFixed(2)),
			legion_gitCwd_fakeSpawn: Number(median(fakeLegionGit).toFixed(2)),
		},
		samples: {
			legionGit: legionGit.map((x) => Number(x.toFixed(2))),
			noLegionGit: noLegionGit.map((x) => Number(x.toFixed(2))),
			legionNonGit: legionNonGit.map((x) => Number(x.toFixed(2))),
			fakeLegionGit: fakeLegionGit.map((x) => Number(x.toFixed(2))),
		},
		env: { node: process.version, cpus: os.cpus().length },
	};
	console.log(JSON.stringify({ bench: "03-launch", ...result }, null, 2));
} finally {
	fs.rmSync(smallRepo, { recursive: true, force: true });
	fs.rmSync(nonGit, { recursive: true, force: true });
}
