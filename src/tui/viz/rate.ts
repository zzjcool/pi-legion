/**
 * Minimal in-memory token-rate sampling.
 *
 * Every tok/s figure in the UI (railway header, /legion header, chart "now",
 * tree detail t/s) uses ONE definition:
 *
 *   numerator   = Δ cumulative output tokens over the trailing window
 *   denominator = Δ cumulative generationMs over the same window
 *                 (falls back to wall-clock window only when generationMs
 *                  is unavailable / zero for that node)
 *
 * generationMs comes from session JSONL: sum of (assistant_ts − prior
 * user/toolResult_ts). Idle and tool gaps are excluded. Approximate —
 * usage lands when each assistant message completes, not mid-stream.
 *
 * Header / snap "now" (`nowRate` / `totalRate` with live node ids) only sums
 * agents that are still `running`. Settled/retired series keep contributing to
 * chart buckets/avg so the history window stays accurate; once nothing is live,
 * "now" is forced to 0 even if the 60s window still holds Δtokens.
 */

import type { VizNode } from "./model.ts";

export const RATE_WINDOW_MS = 60_000;
const DEFAULT_RETENTION_MS = 6 * 60 * 60 * 1000;
const MAX_SAMPLES_PER_NODE = 4096;

interface Series {
	role: string;
	ts: number[];
	/** Cumulative output tokens. */
	value: number[];
	/** Cumulative generation wall ms (parallel to value). */
	gen: number[];
}

export interface RateSeries {
	/** Bucket end timestamps. */
	times: number[];
	/** tok/s per bucket per role. */
	byRole: Map<string, number[]>;
	total: number[];
}

export class RateSampler {
	private readonly series = new Map<string, Series>();
	private readonly retentionMs: number;
	private first: number | undefined;

	constructor(options: { retentionMs?: number } = {}) {
		this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
	}

	get startedAt(): number | undefined {
		return this.first;
	}

	record(now: number, nodes: readonly VizNode[]): void {
		if (!Number.isFinite(now)) return;
		if (this.first === undefined) this.first = now;
		for (const node of nodes) {
			if (node.id === "root") continue;
			let s = this.series.get(node.id);
			if (!s) {
				s = { role: node.role, ts: [], value: [], gen: [] };
				this.series.set(node.id, s);
				// A node born after sampling began starts from zero at its spawn time.
				if (node.startedAt > this.first && node.startedAt < now) {
					s.ts.push(node.startedAt);
					s.value.push(0);
					s.gen.push(0);
				}
			}
			s.role = node.role;
			const last = s.value[s.value.length - 1];
			const lastGen = s.gen[s.gen.length - 1];
			const lastTs = s.ts[s.ts.length - 1];
			// Cumulative counters never decrease; ignore regressions from stale sources.
			const value = last === undefined ? node.tokensOut : Math.max(last, node.tokensOut);
			const gen = lastGen === undefined ? node.generationMs : Math.max(lastGen, node.generationMs);
			if (lastTs !== undefined && now <= lastTs) {
				s.value[s.value.length - 1] = value;
				s.gen[s.gen.length - 1] = gen;
				continue;
			}
			if (
				last !== undefined &&
				value === last &&
				gen === lastGen &&
				s.value.length >= 2 &&
				s.value[s.value.length - 2] === last &&
				s.gen[s.gen.length - 2] === lastGen
			) {
				// Collapse flat runs: move the trailing sample forward.
				s.ts[s.ts.length - 1] = now;
				continue;
			}
			s.ts.push(now);
			s.value.push(value);
			s.gen.push(gen);
			this.prune(s, now);
		}
	}

	private prune(s: Series, now: number): void {
		const cutoff = now - this.retentionMs;
		let drop = 0;
		while (drop < s.ts.length - 1 && s.ts[drop + 1]! < cutoff) drop++;
		if (s.ts.length - drop > MAX_SAMPLES_PER_NODE) drop = s.ts.length - MAX_SAMPLES_PER_NODE;
		if (drop > 0) {
			s.ts.splice(0, drop);
			s.value.splice(0, drop);
			s.gen.splice(0, drop);
		}
	}

	/** Cumulative output tokens at time t (linear between samples, clamped at the ends). */
	valueAt(nodeId: string, t: number): number {
		const s = this.series.get(nodeId);
		if (!s || s.ts.length === 0) return 0;
		return interpolate(s.ts, s.value, t);
	}

	/** Cumulative generationMs at time t. */
	genAt(nodeId: string, t: number): number {
		const s = this.series.get(nodeId);
		if (!s || s.ts.length === 0) return 0;
		return interpolate(s.ts, s.gen, t);
	}

	/**
	 * Output tok/s over the trailing window: ΔtokensOut / (ΔgenerationMs/1000).
	 * When the node has no generationMs samples in the window, falls back to
	 * wall-clock window length so a ledger-only path still yields a number.
	 */
	nodeRate(nodeId: string, now: number, windowMs = RATE_WINDOW_MS): number {
		if (windowMs <= 0) return 0;
		const dOut = Math.max(0, this.valueAt(nodeId, now) - this.valueAt(nodeId, now - windowMs));
		if (dOut <= 0) return 0;
		const dGen = Math.max(0, this.genAt(nodeId, now) - this.genAt(nodeId, now - windowMs));
		const seconds = dGen > 0 ? dGen / 1000 : windowMs / 1000;
		return dOut / seconds;
	}

	/**
	 * Sum of node rates. When `onlyNodeIds` is set (including empty), only those
	 * series contribute — used for header "now". Omit it for chart buckets/avg
	 * so settled agents still paint their trailing-window history.
	 */
	totalRate(now: number, windowMs = RATE_WINDOW_MS, onlyNodeIds?: Iterable<string>): number {
		const filter = onlyNodeIds === undefined ? undefined : new Set(onlyNodeIds);
		let sum = 0;
		for (const id of this.series.keys()) {
			if (filter && !filter.has(id)) continue;
			sum += this.nodeRate(id, now, windowMs);
		}
		return sum;
	}

	/** Header / snap "now" tok/s: live (running) agents only; none live → 0. */
	nowRate(now: number, nodes: readonly VizNode[], windowMs = RATE_WINDOW_MS): number {
		return this.totalRate(now, windowMs, liveRateNodeIds(nodes));
	}

	nodeIds(): string[] {
		return [...this.series.keys()];
	}

	/**
	 * Bucketed tok/s for [from, to], stacked by role. Each bucket is the
	 * trailing-window average ending at the bucket edge (window = max(bucket
	 * span, RATE_WINDOW_MS)), including settled series so history stays painted.
	 * Header "now" may be lower (live-only); bursty flushes stay smoothed.
	 */
	buckets(from: number, to: number, count: number, windowMs = RATE_WINDOW_MS): RateSeries {
		const n = Math.max(1, Math.floor(count));
		const span = Math.max(1, to - from);
		const times = Array.from({ length: n }, (_, i) => from + (span * (i + 1)) / n);
		const byRole = new Map<string, number[]>();
		const total = new Array<number>(n).fill(0);
		for (const [id, s] of this.series) {
			const row = byRole.get(s.role) ?? new Array<number>(n).fill(0);
			const rates = this.nodeBuckets(id, from, to, n, windowMs);
			for (let i = 0; i < n; i++) {
				row[i] = row[i]! + rates[i]!;
				total[i] = total[i]! + rates[i]!;
			}
			byRole.set(s.role, row);
		}
		return { times, byRole, total };
	}

	nodeBuckets(nodeId: string, from: number, to: number, count: number, windowMs = RATE_WINDOW_MS): number[] {
		const s = this.series.get(nodeId);
		const n = Math.max(1, Math.floor(count));
		if (!s) return new Array<number>(n).fill(0);
		const span = Math.max(1, to - from);
		const w = Math.max(span / n, windowMs, 1);
		const out: number[] = [];
		for (let i = 0; i < n; i++) {
			const t = from + (span * (i + 1)) / n;
			out.push(this.nodeRate(nodeId, t, w));
		}
		return out;
	}

	clear(): void {
		this.series.clear();
		this.first = undefined;
	}
}

/** Node ids that contribute to header "now" tok/s (running agents; root excluded). */
export function liveRateNodeIds(nodes: readonly VizNode[]): string[] {
	return nodes.filter((n) => n.id !== "root" && n.status === "running").map((n) => n.id);
}

function interpolate(ts: number[], value: number[], t: number): number {
	if (ts.length === 0) return 0;
	if (t <= ts[0]!) return value[0]!;
	const last = ts.length - 1;
	if (t >= ts[last]!) return value[last]!;
	let lo = 0;
	let hi = last;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (ts[mid]! <= t) lo = mid;
		else hi = mid;
	}
	const t0 = ts[lo]!;
	const t1 = ts[hi]!;
	const v0 = value[lo]!;
	const v1 = value[hi]!;
	return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
}
