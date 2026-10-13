/**
 * Minimal in-memory token-rate sampling.
 *
 * The ledger only stores cumulative tokens per node, so the runtime records a
 * (timestamp, cumulative tokens) sample for every node on each UI refresh.
 * Every tok/s figure in the UI (railway header, /legion header, chart "now")
 * uses ONE definition: tokens gained over the trailing 60s window / 60.
 */

import type { VizNode } from "./model.ts";

export const RATE_WINDOW_MS = 60_000;
const DEFAULT_RETENTION_MS = 6 * 60 * 60 * 1000;
const MAX_SAMPLES_PER_NODE = 4096;

interface Series {
	role: string;
	ts: number[];
	value: number[];
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
				s = { role: node.role, ts: [], value: [] };
				this.series.set(node.id, s);
				// A node born after sampling began starts from zero at its spawn time.
				if (node.startedAt > this.first && node.startedAt < now) {
					s.ts.push(node.startedAt);
					s.value.push(0);
				}
			}
			s.role = node.role;
			const last = s.value[s.value.length - 1];
			const lastTs = s.ts[s.ts.length - 1];
			// Cumulative counters never decrease; ignore regressions from stale sources.
			const value = last === undefined ? node.tokens : Math.max(last, node.tokens);
			if (lastTs !== undefined && now <= lastTs) {
				s.value[s.value.length - 1] = value;
				continue;
			}
			if (last !== undefined && value === last && s.value.length >= 2 && s.value[s.value.length - 2] === last) {
				// Collapse flat runs: move the trailing sample forward.
				s.ts[s.ts.length - 1] = now;
				continue;
			}
			s.ts.push(now);
			s.value.push(value);
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
		}
	}

	/** Cumulative tokens at time t (linear between samples, clamped at the ends). */
	valueAt(nodeId: string, t: number): number {
		const s = this.series.get(nodeId);
		if (!s || s.ts.length === 0) return 0;
		return interpolate(s, t);
	}

	nodeRate(nodeId: string, now: number, windowMs = RATE_WINDOW_MS): number {
		if (windowMs <= 0) return 0;
		return Math.max(0, (this.valueAt(nodeId, now) - this.valueAt(nodeId, now - windowMs)) / (windowMs / 1000));
	}

	totalRate(now: number, windowMs = RATE_WINDOW_MS): number {
		let sum = 0;
		for (const id of this.series.keys()) sum += this.nodeRate(id, now, windowMs);
		return sum;
	}

	nodeIds(): string[] {
		return [...this.series.keys()];
	}

	/** Bucketed tok/s for [from, to], stacked by role. */
	buckets(from: number, to: number, count: number): RateSeries {
		const n = Math.max(1, Math.floor(count));
		const span = Math.max(1, to - from);
		const times = Array.from({ length: n }, (_, i) => from + (span * (i + 1)) / n);
		const byRole = new Map<string, number[]>();
		const total = new Array<number>(n).fill(0);
		for (const s of this.series.values()) {
			const row = byRole.get(s.role) ?? new Array<number>(n).fill(0);
			let prev = interpolate(s, from);
			for (let i = 0; i < n; i++) {
				const value = interpolate(s, times[i]!);
				const rate = Math.max(0, (value - prev) / (span / n / 1000));
				row[i] = row[i]! + rate;
				total[i] = total[i]! + rate;
				prev = value;
			}
			byRole.set(s.role, row);
		}
		return { times, byRole, total };
	}

	nodeBuckets(nodeId: string, from: number, to: number, count: number): number[] {
		const s = this.series.get(nodeId);
		const n = Math.max(1, Math.floor(count));
		if (!s) return new Array<number>(n).fill(0);
		const span = Math.max(1, to - from);
		const out: number[] = [];
		let prev = interpolate(s, from);
		for (let i = 0; i < n; i++) {
			const value = interpolate(s, from + (span * (i + 1)) / n);
			out.push(Math.max(0, (value - prev) / (span / n / 1000)));
			prev = value;
		}
		return out;
	}

	clear(): void {
		this.series.clear();
		this.first = undefined;
	}
}

function interpolate(s: Series, t: number): number {
	const { ts, value } = s;
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
