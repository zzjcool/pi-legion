/**
 * perf-core bench 4 — the synchronous `git` subprocesses on the launch path.
 *
 * Counts real `execFileSync` spawns (patching the CJS `child_process` module and
 * calling `syncBuiltinESMExports`, so `src/runs/worktree.ts`'s ESM import sees
 * the wrapper) and times the launch with and without a git cwd.
 *
 * Also measures a real `git worktree add` inside THIS repo, which is the floor
 * cost of dispatching a centurion.
 *
 * Run: node --experimental-strip-types bench/perf-core/04-launch-git-probe.ts
 */

import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

import { openLegionDb } from "../../src/legion/db.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { RunStore } from "../../src/runs/store.ts";
import { createChildWorktree, isInsideChildWorktree, removeChildWorktree } from "../../src/runs/worktree.ts";
import type { AgentConfig } from "../../src/shared/types.ts";
import type { ChildHandle, LegionSupervisor, SpawnInput } from "../../src/supervisor/types.ts";
import { FakeSupervisor } from "../../test/helpers/fake-supervisor.ts";

// --- spawn counter -----------------------------------------------------------
const nodeCp = createRequire(import.meta.url)("node:child_process") as {
	execFileSync: (cmd: string, args?: readonly string[], ...rest: unknown[]) => unknown;
};
const realExecFileSync = nodeCp.execFileSync;
let spawns: string[] = [];
nodeCp.execFileSync = ((cmd: string, args?: readonly string[], ...rest: unknown[]) => {
	if (typeof cmd === "string" && cmd.startsWith("git")) spawns.push(`${cmd} ${(args ?? []).slice(0, 4).join(" ")}`);
	return realExecFileSync(cmd, args, ...rest);
}) as typeof nodeCp.execFileSync;
syncBuiltinESMExports();

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? (s[mid] as number) : (((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
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
		...over,
	};
}

class NoopSupervisor implements LegionSupervisor {
	readonly uiProxy = new FakeSupervisor().uiProxy;
	private readonly alive = new Set<string>();
	async spawnChild(input: SpawnInput): Promise<ChildHandle> {
		fs.writeFileSync(input.sessionFile, "");
		this.alive.add(input.name);
		return { name: input.name, sessionFile: input.sessionFile, spawnMode: "inprocess" } as ChildHandle;
	}
	async prompt(): Promise<void> {}
	async steer(): Promise<"queued"> { return "queued"; }
	async followUp(): Promise<void> {}
	async abort(): Promise<never> { throw new Error("unused"); }
	async waitSettled(): Promise<never> { throw new Error("unused"); }
	async retire(): Promise<void> {}
	isAlive(name: string): boolean { return this.alive.has(name); }
	onEvent(): () => void { return () => {}; }
	stats(): never { throw new Error("unused"); }
	usage(): null { return null; }
}

/**
 * Remove every worktree this bench registered under `runDir` and delete its
 * branch, then prune the stale admin records.
 *
 * `removeChildWorktree` alone leaves `refs/heads/pi-subagent/*` behind (each
 * `createChildWorktree` mints a fresh random branch), so a bench that forgets
 * this pollutes the host repo with one branch per measured launch. Uses
 * `realExecFileSync` so cleanup never shows up in the spawn counts, and is
 * entirely best-effort: this also runs for the non-git cwd case, which has
 * nothing to clean and where every git command exits 128.
 */
function cleanupWorktrees(repoCwd: string, runDir: string): void {
	try {
		const root = path.join(runDir, "worktrees");
		if (fs.existsSync(root)) {
			for (const entry of fs.readdirSync(root)) {
				removeChildWorktree({ repoCwd, dest: path.join(root, entry) });
			}
		}
		const git = (...args: string[]): string =>
			String(realExecFileSync("git", ["-C", repoCwd, ...args], { encoding: "utf8" }));
		git("worktree", "prune");
		const inUse = new Set(
			git("worktree", "list", "--porcelain")
				.split("\n").filter((line) => line.startsWith("branch "))
				.map((line) => line.slice("branch refs/heads/".length).trim()),
		);
		for (const branch of git("branch", "--list", "pi-subagent/*", "--format=%(refname:short)").split("\n").map((l) => l.trim())) {
			// Local bench branches are `pi-subagent/<probe-N|cent>-<8 hex>`.
			if (!/^pi-subagent\/(?:probe-[0-9]|cent)-[0-9a-f]{8}$/.test(branch)) continue;
			if (inUse.has(branch)) continue;
			try { realExecFileSync("git", ["-C", repoCwd, "branch", "-D", branch], { stdio: "ignore" }); } catch { /* best effort */ }
		}
	} catch {
		/* non-git cwd, or nothing to clean */
	}
}

const repoCwd = path.resolve(import.meta.dirname, "../..");
const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "perf-core-nogit-"));
const nonGitChild = path.join(nonGit, "nested");
fs.mkdirSync(nonGitChild);

interface LaunchRun { ms: number; gitSpawns: number; commands: string[] }

async function launchOnce(opts: { cwd: string; centurion: boolean }): Promise<LaunchRun> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-core-probe-"));
	const root = path.join(dir, ".pi-subagents");
	fs.mkdirSync(path.join(root, "runs"), { recursive: true });
	const db = openLegionDb(path.join(root, "legion.db"));
	insertNode(db, { id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0, status: "running" });
	const store = new RunStore({ rootDir: root });
	const run = store.createRun({ task: "bench", cwd: opts.cwd });
	const runDir = store.runDir(run.runId);
	const orchestrator = new Orchestrator({
		supervisor: new NoopSupervisor(),
		runDir,
		cwd: opts.cwd,
		legion: { db, dbPath: path.join(root, "legion.db"), nodeId: "root", runId: run.runId, runStore: store },
	});
	try {
		spawns = [];
		const t0 = process.hrtime.bigint();
		await orchestrator.launch({
			agent: agent(opts.centurion ? { name: "centurion", role: "centurion" } as Partial<AgentConfig> : {}),
			task: "bench task",
			name: opts.centurion ? "cent" : "w0",
			...(opts.centurion ? { worktree: true } : {}),
		});
		const ms = Number(process.hrtime.bigint() - t0) / 1e6;
		return { ms, gitSpawns: spawns.length, commands: [...spawns] };
	} finally {
		try { db.close(); } catch { /* ignore */ }
		// A centurion launch really did create a worktree in opts.cwd.
		cleanupWorktrees(opts.cwd, runDir);
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const reps = 7;
const gitCwdRuns: LaunchRun[] = [];
const nonGitRuns: LaunchRun[] = [];
const centRuns: LaunchRun[] = [];
try {
	for (let i = 0; i < reps; i += 1) {
		gitCwdRuns.push(await launchOnce({ cwd: repoCwd, centurion: false }));
		nonGitRuns.push(await launchOnce({ cwd: nonGitChild, centurion: false }));
	}
	for (let i = 0; i < 3; i += 1) centRuns.push(await launchOnce({ cwd: repoCwd, centurion: true }));

	// Direct probe cost, isolated.
	const probe = (cwd: string): number[] => {
		const out: number[] = [];
		for (let i = 0; i < 15; i += 1) {
			const t0 = process.hrtime.bigint();
			isInsideChildWorktree(cwd);
			out.push(Number(process.hrtime.bigint() - t0) / 1e6);
		}
		return out;
	};
	const probeGit = probe(repoCwd);
	const probeNonGit = probe(nonGitChild);

	// Real `git worktree add` in THIS repo (the centurion dispatch floor).
	const trackedFiles = Number(
		(String(realExecFileSync("git", ["-C", repoCwd, "ls-files"], { encoding: "utf8" }) as string).match(/\n/g)?.length ?? 0),
	);
	const wtTimes: number[] = [];
	for (let i = 0; i < 3; i += 1) {
		const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-core-wt-"));
		const t0 = process.hrtime.bigint();
		const wt = createChildWorktree({ repoCwd, runDir, name: `probe-${i}` });
		wtTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
		try { removeChildWorktree({ repoCwd, dest: wt.path }); } catch { /* best effort */ }
		try { realExecFileSync("git", ["-C", repoCwd, "branch", "-D", wt.branch], { stdio: "ignore" }); } catch { /* best effort */ }
		fs.rmSync(runDir, { recursive: true, force: true });
	}

	console.log(
		JSON.stringify(
			{
				bench: "04-launch-git-probe",
				env: { node: process.version, cpus: os.cpus().length },
				workerLaunch: {
					gitCwd: {
						medianMs: Number(median(gitCwdRuns.map((r) => r.ms)).toFixed(2)),
						gitSpawnsPerLaunch: gitCwdRuns.map((r) => r.gitSpawns),
						commands: gitCwdRuns[0]?.commands,
						samples: gitCwdRuns.map((r) => Number(r.ms.toFixed(2))),
					},
					nonGitCwd: {
						medianMs: Number(median(nonGitRuns.map((r) => r.ms)).toFixed(2)),
						gitSpawnsPerLaunch: nonGitRuns.map((r) => r.gitSpawns),
						commands: nonGitRuns[0]?.commands,
						samples: nonGitRuns.map((r) => Number(r.ms.toFixed(2))),
					},
				},
				centurionLaunch: {
					ms: centRuns.map((r) => Number(r.ms.toFixed(1))),
					gitSpawnsPerLaunch: centRuns.map((r) => r.gitSpawns),
					commands: centRuns[0]?.commands,
				},
				isolatedProbe: {
					gitCwdMs: Number(median(probeGit).toFixed(2)),
					nonGitCwdMs: Number(median(probeNonGit).toFixed(2)),
					gitCwdSamples: probeGit.map((x) => Number(x.toFixed(2))),
					nonGitCwdSamples: probeNonGit.map((x) => Number(x.toFixed(2))),
				},
				realWorktreeAdd: {
					repoTrackedFiles: trackedFiles,
					medianMs: Number(median(wtTimes).toFixed(1)),
					samples: wtTimes.map((x) => Number(x.toFixed(1))),
				},
			},
			null,
			2,
		),
	);
} finally {
	nodeCp.execFileSync = realExecFileSync;
	syncBuiltinESMExports();
	fs.rmSync(nonGit, { recursive: true, force: true });
}
