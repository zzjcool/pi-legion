/**
 * perf-core bench 8 — steer / abort / process-tree sweep, and the outbox+claim growth.
 *
 * Run: node --experimental-strip-types bench/perf-core/08-steer-abort-sweep.ts
 */

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { enumerateDescendants } from "../../src/supervisor/proc-tree.ts";
import { sweepProcessTree, survivingDescendants } from "../../src/shared/proc-sweep.ts";
import { raceWithTimeout } from "../../src/supervisor/race-timeout.ts";
import { MAX_PENDING_AGE_MS } from "../../src/extension/runtime.ts";
import type { AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../../test/helpers/fake-supervisor.ts";

function p90(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] as number;
}

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

const out: Record<string, any> = { bench: "08-steer-abort-sweep", env: { node: process.version, cpus: os.cpus().length } };

// --- /proc enumeration cost -------------------------------------------------
try {
	const procEntries = fs.readdirSync("/proc").filter((e) => /^\d+$/.test(e));
	out.proc = { numericPids: procEntries.length, totalEntries: fs.readdirSync("/proc").length };
	const self = process.pid;
	const enumSamples: number[] = [];
	for (let i = 0; i < 7; i += 1) {
		const t0 = process.hrtime.bigint();
		enumerateDescendants(self);
		enumSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
	}
	out.proc.enumerateDescendantsMs = Number(median(enumSamples).toFixed(2));
	out.proc.enumerateSamples = enumSamples.map((x) => Number(x.toFixed(2)));

	const surviveSamples: number[] = [];
	for (let i = 0; i < 5; i += 1) {
		const t0 = process.hrtime.bigint();
		survivingDescendants(self);
		surviveSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
	}
	out.proc.survivingDescendantsMs = Number(median(surviveSamples).toFixed(2));
} catch (error) {
	out.procError = String(error);
}

// --- sweepProcessTree on a real process tree --------------------------------
try {
	// One real tree: 6 grandchildren, then sweep it (the verify-timeout path).
	const child = spawn("bash", ["-c", "for i in 1 2 3 4 5 6; do sleep 300 & done; wait"], { stdio: "ignore" });
	await new Promise((r) => setTimeout(r, 250));
	const t0 = process.hrtime.bigint();
	const result = await sweepProcessTree(child.pid as number, { graceMs: 200, killAfterMs: 100 });
	out.sweep = {
		ms: Number((Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1)),
		...result,
	};
	try { child.kill("SIGKILL"); } catch { /* gone */ }
} catch (error) {
	out.sweepError = String(error);
}

// --- raceWithTimeout timer accounting ---------------------------------------
{
	const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
	const samples: number[] = [];
	for (let i = 0; i < 50; i += 1) {
		const t0 = process.hrtime.bigint();
		await raceWithTimeout(Promise.resolve("ok"), 5_000, () => "timeout");
		samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
	}
	const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
	out.raceWithTimeout = {
		perCallMs: Number(median(samples).toFixed(4)),
		activeTimersBefore: before,
		activeTimersAfter: after,
		leakedTimers: after - before,
		timerPerAbort: 2, // clearQueue + interrupt, rpc-supervisor.ts:510/527
	};
}

// --- orchestrator.steer / abort on a 50-child orchestrator -------------------
{
	const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-core-steer-"));
	const supervisor = new FakeSupervisor({ autoSettle: { text: "done", stopReason: "stop" } });
	const orchestrator = new Orchestrator({ supervisor, runDir, cwd: "/tmp/project" });
	try {
		const children = 50;
		for (let i = 0; i < children; i += 1) {
			await orchestrator.launch({ agent: agent(), task: `t${i}`, name: `w${i}` });
		}
		const steerSamples: number[] = [];
		for (let i = 0; i < children; i += 1) {
			const t0 = process.hrtime.bigint();
			await orchestrator.steer(`w${i}`, "hurry up");
			steerSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
		}
		const abortSamples: number[] = [];
		for (let i = 0; i < children; i += 1) {
			const t0 = process.hrtime.bigint();
			await orchestrator.abort(`w${i}`, { clearQueued: true });
			abortSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
		}
		out.steerAbort = {
			children,
			steerMsP50: Number(median(steerSamples).toFixed(3)),
			steerMsP90: Number((p90(steerSamples)).toFixed(3)),
			abortMsP50: Number(median(abortSamples).toFixed(3)),
			abortMsP90: Number((p90(abortSamples)).toFixed(3)),
		};
	} finally {
		fs.rmSync(runDir, { recursive: true, force: true });
	}
}

// --- outbox bound -----------------------------------------------------------
out.outbox = { maxPendingAgeMs: MAX_PENDING_AGE_MS, bounded: true };

// --- does anything bound the number of run dirs? ----------------------------
try {
	const runsRoot = "/root/code/pi-legion/.pi-subagents/runs";
	const entries = fs.readdirSync(runsRoot);
	const ages = entries.map((e) => {
		try { return Date.now() - fs.statSync(path.join(runsRoot, e, "run.json")).mtimeMs; } catch { return -1; }
	}).filter((x) => x >= 0);
	const days = ages.map((a) => a / 86_400_000).sort((a, b) => a - b);
	out.runRegistry = {
		dirs: entries.length,
		ageDaysP50: Number((days[Math.floor(days.length / 2)] ?? 0).toFixed(2)),
		ageDaysMax: Number((days.at(-1) ?? 0).toFixed(2)),
		olderThanRetention14d: days.filter((d) => d > 14).length,
	};
} catch (error) {
	out.runRegistryError = String(error);
}
void execFileSync;

console.log(JSON.stringify(out, null, 2));
