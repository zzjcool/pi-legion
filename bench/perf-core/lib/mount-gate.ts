/**
 * Statistics + gate plumbing shared by `bench/perf-core/09-legion-mount.ts` (#368).
 *
 * Two problems this module exists to solve, both measured on the same box:
 *
 * 1. **Two independent batch medians are not a comparison.** The old floor gate
 *    compared `median(withModal) - median(base)` against `median(blankControl) - median(base)`
 *    where every layer was measured in one long run of its own. On a shared box
 *    each batch median drifts by ±0.5ms on its own, so the gate was a coin flip:
 *    the same commit went red twice and green once within a minute. The fix is a
 *    **paired** statistic: repeat the whole base → modal → blank sequence K times
 *    and take the median of the per-round `slack = modalDelta - blankDelta`, so
 *    the drift that produced both deltas cancels inside each round.
 *
 * 2. **A time gate is meaningless when the box is busy.** A 30s frame benchmark
 *    on a loaded machine measures the co-runner as much as the code. Instead of
 *    flipping between red and green, the time-class gates now report
 *    `not judged` / `ok: "inconclusive"` (process exit 0) with the observed
 *    `environment: { loadavg, cpus, probe }` and one plain sentence, while
 *    byte/structure gates (which do not depend on the clock) keep judging.
 *
 * Everything that decides *anything* here is a pure function of its arguments, so
 * `test/unit/mount-gate-stats.test.ts` can pin the semantics without rendering a
 * single frame. Only `collectEnvironment()` touches the box.
 */

/** Three-state gate verdict: pass / fail / could not judge. */
export type Verdict = true | false | "inconclusive";

// ---------------------------------------------------------------- statistics

/** Median of `xs` (mean of the middle pair for an even count); 0 for an empty list. */
export function median(xs: readonly number[]): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Nearest-rank percentile: the smallest sample at or above `p`. */
export function percentile(xs: readonly number[], p: number): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
	return s[idx] as number;
}

// -------------------------------------------------------- paired slack gate

/** One paired round: the same three layers measured back to back. */
export interface RoundTiming {
	baseMs: readonly number[];
	modalMs: readonly number[];
	blankMs: readonly number[];
}

export interface SlackRound {
	round: number;
	modalDeltaMs: number;
	blankDeltaMs: number;
	/** `modalDelta - blankDelta`: the modal's extra cost over a rect that paints nothing. */
	slackMs: number;
}

export interface SlackSummary {
	perRound: SlackRound[];
	/** Median of the per-round `slackMs` — the gate's statistic. */
	slackMedianMs: number;
	slackMaxMs: number;
	positiveRounds: number;
	negativeRounds: number;
	/** Median of the per-round `modalDeltaMs` (paired), reported next to the old number. */
	modalDeltaMedianMs: number;
	/** Median of the per-round `blankDeltaMs` (paired), i.e. the modal's structural floor. */
	blankControlDeltaMedianMs: number;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Per-round paired deltas and the median slack.
 *
 * Each round compares layers measured inside the same round, so a machine-wide
 * drift that inflates `modalMs` also inflates that round's `blankMs` and cancels
 * out of `slackMs` (see the module comment).
 */
export function summarizeSlack(rounds: readonly RoundTiming[]): SlackSummary {
	const perRound: SlackRound[] = rounds.map((r, i) => {
		const modalDeltaMs = median(r.modalMs) - median(r.baseMs);
		const blankDeltaMs = median(r.blankMs) - median(r.baseMs);
		return {
			round: i,
			modalDeltaMs: round3(modalDeltaMs),
			blankDeltaMs: round3(blankDeltaMs),
			slackMs: round3(modalDeltaMs - blankDeltaMs),
		};
	});
	const slack = perRound.map((r) => r.slackMs);
	return {
		perRound,
		slackMedianMs: round3(median(slack)),
		slackMaxMs: round3(slack.length === 0 ? 0 : Math.max(...slack)),
		positiveRounds: slack.filter((s) => s > 0).length,
		negativeRounds: slack.filter((s) => s < 0).length,
		modalDeltaMedianMs: round3(median(perRound.map((r) => r.modalDeltaMs))),
		blankControlDeltaMedianMs: round3(median(perRound.map((r) => r.blankDeltaMs))),
	};
}

/**
 * Judge the paired slack against `limitMs`.
 *
 * The gate is "the modal's extra cost over the blank-rect control may be at most
 * `limitMs`", which is the old `modalDelta <= blankDelta + 0.5ms` statement
 * rewritten as `modalDelta - blankDelta <= 0.5ms` — but on the **median of the
 * paired per-round slacks** instead of on two independent batch medians.
 *
 * A median over the limit is a fail only when the rounds agree on the sign: if
 * the rounds split (at least two positive and two negative out of five), the
 * "excess" is noise between rounds, not a cost the code pays, so the honest
 * verdict is `inconclusive` — not red, and not green either.
 */
export function judgeSlack(summary: SlackSummary, limitMs: number): { ok: Verdict; reason: string } {
	const n = summary.perRound.length;
	const detail = `${summary.positiveRounds}+/${summary.negativeRounds}- of ${n} rounds`;
	if (summary.slackMedianMs <= limitMs) {
		return { ok: true, reason: `median slack ${summary.slackMedianMs}ms <= ${limitMs}ms (${detail})` };
	}
	const splitSigns = summary.positiveRounds >= 2 && summary.negativeRounds >= 2;
	if (splitSigns) {
		return {
			ok: "inconclusive",
			reason: `median slack ${summary.slackMedianMs}ms > ${limitMs}ms but the rounds split ${detail} — noise between rounds, not a cost`,
		};
	}
	return { ok: false, reason: `median slack ${summary.slackMedianMs}ms > ${limitMs}ms (${detail}, signs agree)` };
}

// ------------------------------------------------------- environment probe

/**
 * Thresholds. Each one is a *policy* about when frame timings stop meaning
 * anything, calibrated against this box (8 logical cores, `reports/368-mount-gate.md`):
 *
 * - `probeRatio 1.5`: p95/min of the tight loop. Idle measured 1.001–1.09 over a
 *   dozen runs; a preempted thread pushes it past 2.
 * - `psiSomeAvg10 5` (%): the kernel's own CPU stall pressure
 *   (`/proc/pressure/cpu`, "some task was waiting for a CPU"). Idle is 0.00 and a
 *   contended host reads 20–30%, but it is **host dependent**: on this SMT box it
 *   only reaches 4.6% with all 8 cores busy, and it stays 0.00 while free cores
 *   remain. Hence the OR below, never PSI alone.
 * - `foreignCores 0.8`: persistent CPU work by other processes, in cores
 *   (`foreignCpu × cpus`). One co-running core on this box reads ~1.0, two read
 *   ~2.0; the idle baseline reads 0–0.15. 0.8 cores is the reviewer's
 *   "0.10 of an 8-CPU box" (#368 review) and is the signal that catches a
 *   co-runner while PSI is still 0.
 * - `loadPerCpu 0.8`: `(loadavg[0] - this process) / cpus`, the slow global
 *   backstop. Idle baseline is 0.13–0.22 (measured 1.1–1.8 raw); 0.8 means ~6.4
 *   runnable threads on 8 CPUs.
 */
export const ENV_LIMITS = {
	probeRatio: 1.5,
	psiSomeAvg10: 5,
	foreignCores: 0.8,
	loadPerCpu: 0.8,
} as const;

/**
 * One runnable thread of `loadavg` is this benchmark itself (the render loop is
 * CPU-bound while it measures). Subtracting it keeps a 5×-in-a-row bench run from
 * disqualifying its own successors.
 */
export const SELF_RUNNABLE_THREADS = 1;

export interface ProbeObservation {
	/** p95/min of the tight-loop batch times: tail inflation from preemption. */
	ratioP95Min: number;
	/** Fraction of the whole machine busy with work that is not this process. */
	foreignCpu: number | null;
	/** `foreignCpu × cpus`, i.e. how many cores of foreign work were running. */
	foreignCores: number | null;
	/** `/proc/pressure/cpu` → `some avg10` (percent), `null` where unavailable. */
	psiSomeAvg10: number | null;
	/** Per-window `foreignCpu` samples, `null` where `/proc/stat` was unreadable. */
	windows: Array<number | null>;
	/** Wall time one batch of the tight loop took (median), for context. */
	batchMs: number;
	/** How long the whole probe took. */
	probeMs: number;
}

export interface Environment {
	loadavg: number[];
	cpus: number;
	probe: ProbeObservation;
}

export interface EnvironmentVerdict {
	satisfied: boolean;
	/** One sentence, present whether satisfied or not. */
	reason: string;
	/** Human-readable list of the thresholds that were crossed. */
	exceeded: string[];
}

/** Pure decision: does the observed environment allow judging time-class gates? */
export function judgeEnvironment(env: Environment, limits: typeof ENV_LIMITS = ENV_LIMITS): EnvironmentVerdict {
	const exceeded: string[] = [];
	const foreignLoad = Math.max(0, (env.loadavg[0] ?? 0) - SELF_RUNNABLE_THREADS);
	const loadPerCpu = env.cpus > 0 ? foreignLoad / env.cpus : 0;
	const foreignCores = env.probe.foreignCpu === null ? null : env.probe.foreignCpu * env.cpus;
	if (env.probe.ratioP95Min > limits.probeRatio) {
		exceeded.push(`probe p95/min ${env.probe.ratioP95Min.toFixed(2)} > ${limits.probeRatio}`);
	}
	if (env.probe.psiSomeAvg10 !== null && env.probe.psiSomeAvg10 > limits.psiSomeAvg10) {
		exceeded.push(`psi some avg10 ${env.probe.psiSomeAvg10.toFixed(1)}% > ${limits.psiSomeAvg10}%`);
	}
	if (foreignCores !== null && foreignCores > limits.foreignCores) {
		exceeded.push(`foreign ${foreignCores.toFixed(2)} cores > ${limits.foreignCores}`);
	}
	if (loadPerCpu > limits.loadPerCpu) {
		exceeded.push(`loadavg ${(env.loadavg[0] ?? 0).toFixed(1)}/${env.cpus} (${loadPerCpu.toFixed(2)} per cpu > ${limits.loadPerCpu})`);
	}
	const stats = `psi some avg10 ${env.probe.psiSomeAvg10 === null ? "n/a" : `${env.probe.psiSomeAvg10.toFixed(1)}%`}, ` +
		`loadavg ${(env.loadavg[0] ?? 0).toFixed(1)}/${env.cpus} (${loadPerCpu.toFixed(2)} per cpu minus this process), ` +
		`foreign ${foreignCores === null ? "n/a" : `${foreignCores.toFixed(2)} cores`}, ` +
		`probe p95/min ${env.probe.ratioP95Min.toFixed(2)}`;
	if (exceeded.length === 0) {
		return { satisfied: true, reason: `environment satisfied (${stats})`, exceeded };
	}
	return { satisfied: false, reason: `environment not satisfied: ${exceeded.join("; ")} (${stats})`, exceeded };
}

/** Tight arithmetic loop; `x` is returned so the JIT cannot drop the body. */
function probeKernel(iterations: number): number {
	let x = 12345;
	for (let i = 0; i < iterations; i++) x = (x * 1103515245 + 12345) & 0x7fffffff;
	return x;
}

const PROBE_KERNEL_ITERATIONS = 400_000;
const PROBE_WARMUP_BATCHES = 8;
const PROBE_WARMUP_WINDOWS = 2;
const PROBE_WINDOWS = 5;
const PROBE_BATCHES_PER_WINDOW = 20;

export interface ProcStat {
	busy: number;
	total: number;
}

/** `busy`/`total` CPU ticks from `/proc/stat` (10ms granularity per CPU); `null` when unreadable. */
export function parseProcStat(raw: string): ProcStat | null {
	try {
		const line = raw.split("\n")[0] ?? "";
		if (!line.startsWith("cpu")) return null;
		const fields = line.trim().split(/\s+/).slice(1).map(Number);
		if (fields.length === 0 || fields.some((n) => !Number.isFinite(n))) return null;
		const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields;
		const busy = user + nice + system + irq + softirq + steal;
		return { busy, total: busy + idle + iowait };
	} catch {
		return null;
	}
}

/**
 * `/proc/pressure/cpu` → its `some avg10` percentage, i.e. the share of wall time
 * during which at least one task was stalled waiting for a CPU. `null` when the
 * kernel does not expose PSI (`CONFIG_PSI` off, `psi=0` on the command line, or a
 * non-Linux host). The verdict is an OR of every available signal, so PSI being
 * absent (or insensitive, see `ENV_LIMITS`) only removes one of them.
 */
export function parsePsi(raw: string): number | null {
	const match = /^some\s+avg10=([\d.]+)/m.exec(raw);
	if (!match) return null;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : null;
}

export interface CpuProbeOptions {
	cpus: number;
	stat: () => ProcStat | null;
	/** `/proc/pressure/cpu` → `some avg10`; `null` when unavailable. */
	psi: () => number | null;
	now: () => number;
	cpuUsage: () => { user: number; system: number };
}

/**
 * Run the tight-loop probe. Every batch is the same fixed chunk of work, so the
 * *absolute* batch time is machine dependent but the **p95/min ratio** and the
 * **foreign CPU fraction** are not: the ratio only grows when this thread gets
 * preempted, and the foreign fraction is machine-wide busy time minus this
 * process's own CPU time (whole-process, V8's background threads included).
 *
 * The foreign fraction is sampled per window and the **minimum** window is
 * reported: a co-runner that is always there shows up in every window, while a
 * 40ms burst from an unrelated process only spoils one.
 */
export function runCpuProbe(options: CpuProbeOptions): ProbeObservation {
	const started = options.now();
	for (let i = 0; i < PROBE_WARMUP_BATCHES; i++) probeKernel(PROBE_KERNEL_ITERATIONS);
	const window = (): { times: number[]; foreign: number | null } => {
		const stat0 = options.stat();
		const cpu0 = options.cpuUsage();
		const t0 = options.now();
		const times: number[] = [];
		for (let i = 0; i < PROBE_BATCHES_PER_WINDOW; i++) {
			const s = options.now();
			probeKernel(PROBE_KERNEL_ITERATIONS);
			times.push(options.now() - s);
		}
		const t1 = options.now();
		const cpu1 = options.cpuUsage();
		const stat1 = options.stat();
		const elapsedMs = t1 - t0;
		if (!stat0 || !stat1 || elapsedMs <= 0 || options.cpus <= 0) return { times, foreign: null };
		const ownFrac = (((cpu1.user + cpu1.system) - (cpu0.user + cpu0.system)) / 1000) / elapsedMs / options.cpus;
		const systemFrac = Math.min(1, (stat1.busy - stat0.busy) / 100 / (elapsedMs / 1000) / options.cpus);
		return { times, foreign: Math.max(0, systemFrac - ownFrac) };
	};
	for (let i = 0; i < PROBE_WARMUP_WINDOWS; i++) window();
	const windows: Array<{ times: number[]; foreign: number | null }> = [];
	for (let i = 0; i < PROBE_WINDOWS; i++) windows.push(window());
	const batches = windows.flatMap((w) => w.times);
	const min = batches.length === 0 ? 0 : Math.min(...batches);
	const foreigns = windows.map((w) => w.foreign);
	const observed = foreigns.filter((v): v is number => v !== null);
	const foreignCpu = observed.length === 0 ? null : Math.round(Math.min(...observed) * 1000) / 1000;
	const psiSomeAvg10 = options.psi();
	return {
		ratioP95Min: min > 0 ? Math.round((percentile(batches, 0.95) / min) * 1000) / 1000 : 0,
		foreignCpu,
		foreignCores: foreignCpu === null ? null : Math.round(foreignCpu * options.cpus * 100) / 100,
		psiSomeAvg10,
		windows: foreigns.map((v) => (v === null ? null : Math.round(v * 1000) / 1000)),
		batchMs: Math.round(median(batches) * 1000) / 1000,
		probeMs: Math.round(options.now() - started),
	};
}

// ------------------------------------------------------------------- gates

export interface Gate {
	gate: string;
	/** `time` = depends on the clock (skipped when the box is busy); `bytes`/`structure` = not. */
	kind: "time" | "bytes" | "structure";
	/** `null` = not judged. */
	ok: boolean | null;
	judged: boolean;
	actual: number | string;
	limit: number | string;
	note?: string;
}

/**
 * Fold the gates into the script's three-state `ok`.
 *
 * - any judged gate that failed ⇒ `false` (a byte gate still fails on a busy box:
 *   those numbers are not time dependent);
 * - otherwise, if some gate could not be judged ⇒ `"inconclusive"`;
 * - otherwise ⇒ `true`.
 */
export function summarizeGates(gates: readonly Gate[], env: EnvironmentVerdict): { ok: Verdict; summary: string } {
	const judged = gates.filter((g) => g.judged);
	const failed = judged.filter((g) => g.ok === false);
	const skipped = gates.filter((g) => !g.judged);
	const passed = judged.length - failed.length;
	if (failed.length > 0) {
		const list = failed.map((g) => `${g.gate}: ${g.actual} (limit ${g.limit})`).join("; ");
		const tail = skipped.length > 0 ? ` — ${skipped.length} time gate(s) not judged: ${env.reason}` : "";
		return { ok: false, summary: `FAIL ${list}${tail}` };
	}
	if (skipped.length > 0) {
		return {
			ok: "inconclusive",
			summary: `SKIP (${env.reason}) — ${passed}/${judged.length} clock-independent gate(s) judged and passing, ` +
				`${skipped.length} time gate(s) not judged`,
		};
	}
	return { ok: true, summary: `OK ${passed}/${judged.length} gates (${env.reason})` };
}

/**
 * Observe this machine: `loadavg`/`cpus` plus the tight-loop CPU probe.
 * Impure (reads `/proc/stat`, runs ~0.3s of work) — everything that *decides*
 * anything still goes through the pure `judgeEnvironment()` above.
 */
export async function collectEnvironment(): Promise<Environment> {
	const os = await import("node:os");
	const { readFileSync } = await import("node:fs");
	const cpuCount = os.cpus().length;
	const loadavg = os.loadavg();
	const stat = (): ProcStat | null => {
		try {
			return parseProcStat(readFileSync("/proc/stat", "utf8"));
		} catch {
			return null;
		}
	};
	const psi = (): number | null => {
		try {
			return parsePsi(readFileSync("/proc/pressure/cpu", "utf8"));
		} catch {
			return null;
		}
	};
	const probe = runCpuProbe({
		cpus: cpuCount,
		stat,
		psi,
		now: () => performance.now(),
		cpuUsage: () => {
			const usage = process.cpuUsage();
			return { user: usage.user, system: usage.system };
		},
	});
	return { loadavg, cpus: cpuCount, probe };
}
