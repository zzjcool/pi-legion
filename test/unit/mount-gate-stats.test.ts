import { test } from "node:test";
import assert from "node:assert/strict";
import {
	ENV_LIMITS,
	parsePsi,
	judgeEnvironment,
	judgeSlack,
	median,
	parseProcStat,
	percentile,
	runCpuProbe,
	summarizeGates,
	summarizeSlack,
	type Environment,
	type Gate,
} from "../../bench/perf-core/lib/mount-gate.ts";

/**
 * #368: `bench/perf-core/09-legion-mount.ts` used to compare two batch medians
 * taken a minute apart (`modalDelta <= blankDelta + 0.5`), so on a shared box the
 * same commit failed 2 of 3 runs. These cases pin the replacement: paired slack
 * gated on its median over rounds, and an environment probe that turns time gates
 * into `not judged` instead of flipping between red and green.
 */

const round = (ms: number[]): number[] => ms;

const idleEnvironment = (): Environment => ({
	loadavg: [0.4, 0.3, 0.3],
	cpus: 8,
	probe: { ratioP95Min: 1.02, foreignCpu: 0.01, foreignCores: 0.08, psiSomeAvg10: 0, windows: [0.01, 0, 0.02], batchMs: 2.2, probeMs: 330 },
});

test("#368 statistics keep the nearest-rank median/percentile the bench had", () => {
	assert.equal(median([]), 0);
	assert.equal(median([3]), 3);
	assert.equal(median([3, 1, 2]), 2);
	assert.equal(median([1, 2, 3, 4]), 2.5);
	assert.equal(percentile([10, 1, 2, 3, 4], 0.95), 10);
	assert.equal(percentile([], 0.95), 0);
});

test("#368 slack is paired inside each round, so a shared drift cancels", () => {
	// Round 2 is globally slower than round 1 (a co-tenant woke up): all three
	// layers inherit it, so the *slack* — modal's extra cost over the blank rect —
	// must not move. The old batch-median form saw modal +3.0 vs blank +2.4 and
	// could trip the 0.5ms epsilon; the paired statistic reports the same 0.4 in
	// both rounds.
	const summary = summarizeSlack([
		{ baseMs: round([1, 1, 1]), modalMs: round([3.4, 3.4, 3.4]), blankMs: round([3, 3, 3]) },
		{ baseMs: round([1.6, 1.6, 1.6]), modalMs: round([4, 4, 4]), blankMs: round([3.6, 3.6, 3.6]) },
	]);
	assert.deepEqual(summary.perRound.map((r) => r.slackMs), [0.4, 0.4]);
	assert.equal(summary.slackMedianMs, 0.4);
	assert.equal(summary.modalDeltaMedianMs, 2.4);
	assert.equal(summary.blankControlDeltaMedianMs, 2);
});

test("#368 the slack gate passes under the epsilon even when one round is noisy", () => {
	// 4 of 5 rounds are clean, one round carries a 0.6ms blip: the median is 0.2.
	const summary = summarizeSlack([
		{ baseMs: [1], modalMs: [3.2], blankMs: [3] },
		{ baseMs: [1], modalMs: [3.2], blankMs: [3] },
		{ baseMs: [1], modalMs: [3.2], blankMs: [3] },
		{ baseMs: [1], modalMs: [3.2], blankMs: [3] },
		{ baseMs: [1], modalMs: [3.8], blankMs: [3] },
	]);
	assert.equal(summary.slackMedianMs, 0.2);
	assert.deepEqual(judgeSlack(summary, 0.5).ok, true);
});

test("#368 a consistently over-budget slack is a fail, not a skip", () => {
	const summary = summarizeSlack([
		{ baseMs: [1], modalMs: [4.0], blankMs: [3] },
		{ baseMs: [1], modalMs: [4.1], blankMs: [3] },
		{ baseMs: [1], modalMs: [4.0], blankMs: [3] },
		{ baseMs: [1], modalMs: [4.2], blankMs: [3] },
		{ baseMs: [1], modalMs: [4.0], blankMs: [3] },
	]);
	assert.equal(summary.slackMedianMs, 1);
	assert.equal(summary.positiveRounds, 5);
	assert.equal(judgeSlack(summary, 0.5).ok, false);
});

test("#368 split signs over the epsilon are inconclusive, never red", () => {
	const summary = summarizeSlack([
		{ baseMs: [1], modalMs: [5.0], blankMs: [3] },
		{ baseMs: [1], modalMs: [5.0], blankMs: [3] },
		{ baseMs: [1], modalMs: [1.0], blankMs: [3] },
		{ baseMs: [1], modalMs: [1.0], blankMs: [3] },
		{ baseMs: [1], modalMs: [5.0], blankMs: [3] },
	]);
	assert.equal(summary.slackMedianMs, 2);
	assert.equal(summary.positiveRounds, 3);
	assert.equal(summary.negativeRounds, 2);
	const verdict = judgeSlack(summary, 0.5);
	assert.equal(verdict.ok, "inconclusive");
	assert.match(verdict.reason, /split/);
});

test("#368 environment: the box's own baseline is satisfied (#368 review)", () => {
	// Exactly the machine the review measured: 8 logical cores, resident loadavg
	// 1.7-1.8 (0.22/core, someone else's long-running agents), PSI 0.00 — nothing is
	// ever stalled waiting for a CPU, so the benchmark is trustworthy.
	const reviewBaseline: Environment = {
		loadavg: [1.78, 1.74, 1.7],
		cpus: 8,
		probe: { ratioP95Min: 1.03, foreignCpu: 0.019, foreignCores: 0.15, psiSomeAvg10: 0, windows: [0.019], batchMs: 2.2, probeMs: 330 },
	};
	const verdict = judgeEnvironment(reviewBaseline);
	assert.equal(verdict.satisfied, true, verdict.reason);

	// ... and an idle box with nothing at all going on.
	assert.equal(judgeEnvironment(idleEnvironment()).satisfied, true);

	// A different machine without PSI: the foreign/loadavg thresholds are the whole
	// judgement, and 1.9% of capacity (= 0.15 cores) is not a co-runner.
	const noPsiIdle: Environment = {
		...idleEnvironment(),
		probe: { ...idleEnvironment().probe, psiSomeAvg10: null, foreignCpu: 0.019, foreignCores: 0.15 },
	};
	assert.equal(judgeEnvironment(noPsiIdle).satisfied, true);
});

test("#368 environment: two busy cores are not judged, on PSI or on foreign cores", () => {
	// A box that is genuinely oversubscribed: PSI says tasks stall 20% of the time.
	const psiBusy: Environment = {
		...idleEnvironment(),
		probe: { ...idleEnvironment().probe, psiSomeAvg10: 20 },
	};
	const psiVerdict = judgeEnvironment(psiBusy);
	assert.equal(psiVerdict.satisfied, false);
	assert.match(psiVerdict.reason, /psi some avg10 20\.0% > 5%/);

	// This box with two `node -e 'for(;;){}'` loops: PSI still reads 0.00 (five cores
	// are free, so nothing stalls), foreign CPU reads 2.0 cores. PSI alone would miss
	// it, which is why the foreign-cores signal is OR-ed in.
	const foreignBusy: Environment = {
		loadavg: [3.1, 2.4, 1.9],
		cpus: 8,
		probe: { ratioP95Min: 1.04, foreignCpu: 0.25, foreignCores: 2, psiSomeAvg10: 0, windows: [0.25], batchMs: 2.2, probeMs: 330 },
	};
	const foreignVerdict = judgeEnvironment(foreignBusy);
	assert.equal(foreignVerdict.satisfied, false);
	assert.match(foreignVerdict.reason, /foreign 2\.00 cores > 0\.8/);
});

test("#368 environment: each signal fails on its own", () => {
	const busyProbe: Environment = {
		...idleEnvironment(),
		probe: { ...idleEnvironment().probe, ratioP95Min: 2.4 },
	};
	assert.equal(judgeEnvironment(busyProbe).satisfied, false);
	assert.match(judgeEnvironment(busyProbe).reason, /probe p95\/min/);

	// loadavg backstop: ~6.5 runnable threads of foreign work on 8 CPUs.
	const loaded: Environment = { ...idleEnvironment(), loadavg: [7.5, 6.0, 4.0] };
	assert.equal(judgeEnvironment(loaded).satisfied, false);
	assert.match(judgeEnvironment(loaded).reason, /loadavg 7\.5\/8/);

	// Load average counts this benchmark's own render thread, and back-to-back runs
	// decay into the next reading: 1.7 on an otherwise idle box is this script
	// itself (idle measurements were 1.1–1.8), so it must not disqualify run N+1.
	const selfOnly: Environment = { ...idleEnvironment(), loadavg: [1.74, 1.6, 1.5] };
	assert.equal(judgeEnvironment(selfOnly).satisfied, true);

	// A resident co-runner is a co-runner even with PSI at 0: >= 0.8 cores of foreign
	// work means the machine is not exclusively ours.
	const resident: Environment = {
		...idleEnvironment(),
		loadavg: [1.7, 1.6, 1.5],
		probe: { ...idleEnvironment().probe, foreignCpu: 0.15, foreignCores: 1.2 },
	};
	assert.equal(judgeEnvironment(resident).satisfied, false);

	// A platform without /proc/stat and without PSI: those signals are simply not
	// judged on, the ratio and load average still are.
	const noProc: Environment = {
		...idleEnvironment(),
		probe: { ratioP95Min: 1.1, foreignCpu: null, foreignCores: null, psiSomeAvg10: null, windows: [], batchMs: 2.2, probeMs: 300 },
	};
	assert.equal(judgeEnvironment(noProc).satisfied, true);
});

test("#368 the probe measures tail inflation and foreign CPU, hand-driven", () => {
	assert.deepEqual(parseProcStat("cpu  100 0 0 900 0 0 0 0 0 0\n"), { busy: 100, total: 1000 });
	assert.equal(parseProcStat(""), null);
	assert.equal(parseProcStat("intr 1 2 3"), null);

	const procStat = (raw: string): { busy: number; total: number } | null => parseProcStat(raw);
	const fixedStat = procStat("cpu  100 0 0 900 0 0 0 0 0 0");
	assert.ok(fixedStat);

	// Hand-driven clock: uniform batches of 1ms, and 8 CPU ticks of foreign work per
	// 41ms window on 8 CPUs => foreign CPU fraction ~0.24.
	const uniformClock = (): (() => number) => {
		let t = 0;
		return () => {
			t += 1;
			return t;
		};
	};
	let statReads = 0;
	const stat = (): { busy: number; total: number } | null => {
		const busy = Math.floor((statReads + 1) / 2) * 8;
		statReads += 1;
		return { busy, total: busy + 1000 };
	};
	const uniform = runCpuProbe({ cpus: 8, stat, psi: () => 0, now: uniformClock(), cpuUsage: () => ({ user: 0, system: 0 }) });
	assert.equal(uniform.ratioP95Min, 1, "uniform batches => no tail inflation");
	assert.equal(uniform.batchMs, 1);
	assert.equal(uniform.windows.length, 5);
	assert.ok(Math.abs((uniform.foreignCpu ?? -1) - 0.24) < 0.02, `foreign CPU ~0.24, got ${String(uniform.foreignCpu)}`);
	assert.ok(Math.abs((uniform.foreignCores ?? -1) - 1.92) < 0.2, `foreign cores ~1.92, got ${String(uniform.foreignCores)}`);
	assert.equal(uniform.psiSomeAvg10, 0);
	assert.equal(parsePsi("some avg10=26.83 avg60=12.37 avg300=3.44 total=8186958024\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"), 26.83);
	assert.equal(parsePsi("full avg10=0.00 avg60=0.00 avg300=0.00 total=0"), null);

	// Every 10th clock call jumps 40ms: the tail moves, the median does not.
	let calls = 0;
	let clock = 0;
	const spikyClock = (): number => {
		calls += 1;
		clock += calls % 10 === 0 ? 40 : 1;
		return clock;
	};
	statReads = 0;
	const spiky = runCpuProbe({ cpus: 8, stat, psi: () => 0, now: spikyClock, cpuUsage: () => ({ user: 0, system: 0 }) });
	assert.ok(spiky.ratioP95Min > 1.5, `p95/min should show the spikes, got ${spiky.ratioP95Min}`);
});

test("#368 gates: busy box skips time gates but still fails a byte gate", () => {
	const busy = judgeEnvironment({ ...idleEnvironment(), loadavg: [7.5, 6.0, 4.0] });
	const gates: Gate[] = [
		{ gate: "page medianMs<=5.0", kind: "time", ok: null, judged: false, actual: 1.1, limit: 5 },
		{ gate: "bytesGrowthPct<=2.0", kind: "bytes", ok: true, judged: true, actual: -2.4, limit: 2 },
	];
	const inconclusive = summarizeGates(gates, busy);
	assert.equal(inconclusive.ok, "inconclusive");
	assert.match(inconclusive.summary, /^SKIP \(environment not satisfied/);

	const byteFail: Gate[] = [
		{ gate: "page medianMs<=5.0", kind: "time", ok: null, judged: false, actual: 1.1, limit: 5 },
		{ gate: "bytesGrowthPct<=2.0", kind: "bytes", ok: false, judged: true, actual: 9.1, limit: 2 },
	];
	const failed = summarizeGates(byteFail, busy);
	assert.equal(failed.ok, false);

	const allGreen = summarizeGates(
		[
			{ gate: "page medianMs<=5.0", kind: "time", ok: true, judged: true, actual: 1.1, limit: 5 },
			{ gate: "bytesGrowthPct<=2.0", kind: "bytes", ok: true, judged: true, actual: -2.4, limit: 2 },
		],
		judgeEnvironment(idleEnvironment()),
	);
	assert.equal(allGreen.ok, true);
	assert.match(allGreen.summary, /^OK 2\/2 gates/);
});

test("#368 the exported thresholds match the documented derivation", () => {
	// Guards the numbers `reports/368-mount-gate.md` derives from the idle run
	// distribution: idle p95/min ≤ 1.09, idle foreign CPU ≤ 0.05, idle load/cpu ≤ 0.10.
	assert.ok(ENV_LIMITS.probeRatio >= 1.09 && ENV_LIMITS.probeRatio <= 2, "probe ratio between idle max and saturation");
	assert.ok(ENV_LIMITS.psiSomeAvg10 >= 1 && ENV_LIMITS.psiSomeAvg10 <= 15, "PSI between idle 0 and a saturated 20-30%");
	assert.ok(ENV_LIMITS.foreignCores >= 0.4 && ENV_LIMITS.foreignCores <= 2, "foreign cores below the two-busy-core case");
	assert.ok(ENV_LIMITS.loadPerCpu > 0.22 && ENV_LIMITS.loadPerCpu <= 1.5, "loadavg/cpu above the box baseline 0.22");
});
