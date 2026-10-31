/**
 * Minimal in-memory token-rate sampling.
 *
 * Two UI surfaces show throughput with different definitions:
 *
 * - Header / snap tok/s (`nowRate`): 60s trailing window + live (running)
 *   agents only. Numerator = Δ cumulative output tokens; denominator =
 *   Δ cumulative generationMs over the same window (falls back to wall-clock
 *   window when generationMs is unavailable / zero, or when in-window
 *   ΔgenerationMs is below MIN_RATE_GENERATION_MS — same 1s floor as the
 *   tree-row gate). Once nothing is live, the header rate is 0 even if the
 *   window still holds Δtokens.
 * - Tree-row label (`avg t/s` in status.ts): lifetime cumulative average
 *   `tokensOut / (generationMs/1000)` — no window, no live filter.
 *
 * generationMs comes from session JSONL: sum of (assistant_ts − prior
 * user/toolResult_ts). Idle and tool gaps are excluded. Approximate —
 * usage lands when each assistant message completes, not mid-stream.
 *
 * Settled/retired series keep contributing to chart buckets/avg so the
 * history window stays accurate. #346: they only do so while the frame still
 * paints them — `buckets()` takes the frame's visible ids, and a series nobody
 * shows costs nothing per frame even though its samples are kept.
 */

import type { VizNode } from "./model.ts";

export const RATE_WINDOW_MS = 60_000;
/**
 * Min in-window ΔgenerationMs before trusting gen as the tok/s denominator.
 * Matches tree-row t/s gate (`generationMs >= 1000` in status.ts). Below this,
 * fall back to wall-clock window length so a 1ms gen flush cannot spike to M.
 */
export const MIN_RATE_GENERATION_MS = 1_000;
const DEFAULT_RETENTION_MS = 6 * 60 * 60 * 1000;
const MAX_SAMPLES_PER_NODE = 4096;

interface Series {
	role: string;
	ts: number[];
	/** Cumulative output tokens. */
	value: number[];
	/** Cumulative generation wall ms (parallel to value). */
	gen: number[];
	/**
	 * #346: last timestamp at which this series' sampled value actually CHANGED —
	 * or its birth, when it was first seen.
	 *
	 * Every later sample is a flat continuation of that value: `record()`'s
	 * flat-run collapse moves `ts[last]` forward WITHOUT touching the value, which
	 * is exactly why the last SAMPLE timestamp cannot answer "is this series still
	 * producing?". Invariant: all samples at `t > changedAt` carry the value at
	 * `changedAt`, so `interpolate` is constant on `[changedAt, ∞)`.
	 */
	changedAt: number;
}

export interface RateSeries {
	/** Bucket end timestamps. */
	times: number[];
	/** tok/s per bucket per role. */
	byRole: Map<string, number[]>;
	total: number[];
}

/**
 * #346: knobs for one bucketing pass.
 *
 * `onlyNodeIds` is the frame-visibility filter: only series the frame actually
 * paints are bucketed. Series that were recorded once and never removed (a
 * finished child, a node that left the subtree) keep their raw samples — the
 * chart just does not pay for them every frame — so a pass is O(visible
 * series), not O(every series ever recorded). Omitting it keeps the unfiltered
 * semantics for callers that really do want every series.
 */
export interface BucketOptions {
	/** Trailing-window length per bucket; defaults to `RATE_WINDOW_MS`. */
	windowMs?: number;
	/** Restrict the pass to these series ids (including empty → nothing). */
	onlyNodeIds?: Iterable<string>;
}

export class RateSampler {
	private readonly series = new Map<string, Series>();
	private readonly retentionMs: number;
	private first: number | undefined;
	/** Wall time of the latest tokensOut/gen change across all series (not flat-collapse moves). */
	private lastChange: number | undefined;
	/**
	 * #346 diagnostics: series visited vs. provably skipped by the most recent
	 * `buckets()` pass. Read-only observability — the test that pins "a frame pays
	 * for the series that changed inside its window, not for every series ever
	 * recorded" asserts on it, and nothing in the sampler reads it back.
	 */
	readonly lastPass: { walked: number; skipped: number } = { walked: 0, skipped: 0 };

	constructor(options: { retentionMs?: number } = {}) {
		this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
	}

	get startedAt(): number | undefined {
		return this.first;
	}

	/**
	 * Latest timestamp where any series recorded a substantive tokensOut or
	 * generationMs change. Flat-collapse (advancing a flat trailing sample to
	 * `now`) does not move this — chart x-axis freezes until real data arrives.
	 */
	get lastChangeAt(): number | undefined {
		return this.lastChange;
	}

	record(now: number, nodes: readonly VizNode[]): void {
		if (!Number.isFinite(now)) return;
		if (this.first === undefined) this.first = now;
		for (const node of nodes) {
			if (node.id === "root") continue;
			let s = this.series.get(node.id);
			if (!s) {
				s = { role: node.role, ts: [], value: [], gen: [], changedAt: now };
				this.series.set(node.id, s);
				// A node born after sampling began starts from zero at its spawn time.
				if (node.startedAt > this.first && node.startedAt < now) {
					s.ts.push(node.startedAt);
					s.value.push(0);
					s.gen.push(0);
					s.changedAt = node.startedAt;
				}
			}
			s.role = node.role;
			const last = s.value[s.value.length - 1];
			const lastGen = s.gen[s.gen.length - 1];
			const lastTs = s.ts[s.ts.length - 1];
			// Cumulative counters never decrease; ignore regressions from stale sources.
			const value = last === undefined ? node.tokensOut : Math.max(last, node.tokensOut);
			const gen = lastGen === undefined ? node.generationMs : Math.max(lastGen, node.generationMs);
			const changed = last === undefined || value !== last || gen !== lastGen;
			if (lastTs !== undefined && now <= lastTs) {
				s.value[s.value.length - 1] = value;
				s.gen[s.gen.length - 1] = gen;
				if (changed) {
					// #346: a backward sample still rewrites the value at `lastTs`, so that
					// is where the last real change now sits.
					s.changedAt = Math.max(s.changedAt, lastTs);
					this.noteChange(lastTs);
				}
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
				// Does NOT advance lastChangeAt — chart x-axis stays frozen — and does
				// NOT advance `changedAt`: the value is the same one as before.
				s.ts[s.ts.length - 1] = now;
				continue;
			}
			s.ts.push(now);
			s.value.push(value);
			s.gen.push(gen);
			if (changed) {
				s.changedAt = now;
				this.noteChange(now);
			}
			this.prune(s, now);
		}
	}

	private noteChange(at: number): void {
		if (!Number.isFinite(at)) return;
		this.lastChange = this.lastChange === undefined ? at : Math.max(this.lastChange, at);
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
	 * When in-window ΔgenerationMs is 0 or below MIN_RATE_GENERATION_MS, falls
	 * back to wall-clock window length so a ledger-only path still yields a
	 * number and a sub-second gen flush cannot report M-level TPS.
	 */
	nodeRate(nodeId: string, now: number, windowMs = RATE_WINDOW_MS): number {
		if (windowMs <= 0) return 0;
		const s = this.series.get(nodeId);
		if (!s) return 0;
		return this.rateOf(s, now, windowMs);
	}

	/**
	 * Sum of node rates. When `onlyNodeIds` is set (including empty), only those
	 * series contribute — used for the header tok/s. Omit it for chart buckets/avg
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

	/** Header / snap tok/s: live (running) agents only; none live → 0. */
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
	 *
	 * #346: ONE pass per frame (the chart body and its stats used to run this
	 * twice with identical arguments), no per-series scratch array (the rows are
	 * accumulated straight into the role totals), and only the series this frame
	 * paints are visited. A series whose last CHANGE sits at or before the first
	 * bucket's trailing edge is skipped: `interpolate` clamps at both ends there and
	 * every sample after `changedAt` is flat, so every Δ — and therefore every
	 * bucket — is provably 0. All three are byte-identical to the exhaustive
	 * version modulo a role whose whole column is zero (it then never enters
	 * `byRole`; the chart derives its role list from the nodes, so nothing is
	 * painted differently).
	 *
	 * #346 (review major 2): the skip used `ts[last]`, the last SAMPLE time — and
	 * `record()`'s flat-run collapse pushes that forward every frame for every
	 * settled row still in the subtree, so the skip never fired in production
	 * (measured 200 series / 190 settled ⇒ walked 200, skipped 0). `changedAt` is
	 * the timestamp the value last moved, so a settled child is skipped as soon as
	 * its last contribution has scrolled out of the window.
	 */
	buckets(from: number, to: number, count: number, options: BucketOptions = {}): RateSeries {
		const n = Math.max(1, Math.floor(count));
		const span = Math.max(1, to - from);
		const times = Array.from({ length: n }, (_, i) => from + (span * (i + 1)) / n);
		const windowMs = options.windowMs ?? RATE_WINDOW_MS;
		const w = Math.max(span / n, windowMs, 1);
		const byRole = new Map<string, number[]>();
		const total = new Array<number>(n).fill(0);
		const visible = options.onlyNodeIds === undefined ? undefined : new Set(options.onlyNodeIds);
		// The first bucket's trailing edge: at or after this, a series that has not
		// changed since is flat on both ends of every window ⇒ every Δ is 0.
		const quietBefore = times[0]! - w;
		let walked = 0;
		let skipped = 0;
		for (const [id, s] of this.series) {
			if (visible && !visible.has(id)) continue;
			if (s.changedAt <= quietBefore) {
				skipped += 1;
				continue;
			}
			walked += 1;
			const row = byRole.get(s.role) ?? new Array<number>(n).fill(0);
			for (let i = 0; i < n; i++) {
				const rate = this.rateOf(s, times[i]!, w);
				row[i] = row[i]! + rate;
				total[i] = total[i]! + rate;
			}
			byRole.set(s.role, row);
		}
		this.lastPass.walked = walked;
		this.lastPass.skipped = skipped;
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
			out.push(this.rateOf(s, t, w));
		}
		return out;
	}

	/**
	 * Trailing-window tok/s for one series at `t` — the body of `nodeRate` without
	 * the per-call `Map` lookup. `buckets()` walks a few thousand of these per
	 * frame (#346: 200 series × 51 buckets), so the lookup was ~20% of the pass.
	 */
	private rateOf(s: Series, t: number, windowMs: number): number {
		if (windowMs <= 0) return 0;
		const dOut = Math.max(0, interpolate(s.ts, s.value, t) - interpolate(s.ts, s.value, t - windowMs));
		if (dOut <= 0) return 0;
		const dGen = Math.max(0, interpolate(s.ts, s.gen, t) - interpolate(s.ts, s.gen, t - windowMs));
		const seconds = dGen >= MIN_RATE_GENERATION_MS ? dGen / 1000 : windowMs / 1000;
		return dOut / seconds;
	}

	clear(): void {
		this.series.clear();
		this.first = undefined;
		this.lastChange = undefined;
		this.lastPass.walked = 0;
		this.lastPass.skipped = 0;
	}
}

/** Node ids that contribute to the header tok/s (running agents; root excluded). */
export function liveRateNodeIds(nodes: readonly VizNode[]): string[] {
	return nodes.filter((n) => n.id !== "root" && n.status === "running").map((n) => n.id);
}

/**
 * #346: node ids a frame paints, i.e. the series the chart is allowed to bucket.
 * Unlike `liveRateNodeIds` this keeps settled/retired rows — the chart still
 * paints their trailing-window history — and only drops the root and rows the
 * frame does not show.
 */
export function visibleRateNodeIds(nodes: readonly VizNode[]): string[] {
	return nodes.filter((n) => n.id !== "root").map((n) => n.id);
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
