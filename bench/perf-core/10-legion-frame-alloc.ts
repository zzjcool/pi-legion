/**
 * perf-core bench 10 — per-frame allocation of the `/legion` page (#364).
 *
 * `docs/contracts/viz-frame-alloc-v1.md` §0 freezes the two numbers this script
 * gates on: a 200-node frame on the real `Theme(dark)` may allocate at most
 * **2.0MB** at both 120×40 and 200×60, without moving the visible bytes or the
 * frame time. #362 already removed the per-write `Canvas.set()` allocation; what
 * is left is the per-frame scaffolding every panel rebuilds from scratch
 * (recon: drawGalaxy 0.93–1.23MB, `toLines` 0.44–1.01MB, drawChart 0.38–0.62MB,
 * `new Canvas` prefill 190/472KB, the other panels ≈0.35–0.5MB).
 *
 * Measurement (contract §4.1, deliberately not the `allocProbe` churn number the
 * earlier evidence used — no mid-batch GC, one frame per sample):
 *
 *   - allocation: `--expose-gc`; for each of 20 samples run a full GC, read
 *     `heapUsed`, render exactly ONE frame, read `heapUsed` again, keep the
 *     frame alive across the second read. The reported `frameAllocKB` is the
 *     MEDIAN of the 20 deltas (a single sample on a shared box is noise; the
 *     median is also what makes a 2.0MB gate meaningful).
 *   - time: 5 rounds × 50 frames of the same frame; `median` / `p95` over all
 *     250 samples, nearest-rank p95 (same shape as bench 09).
 *   - digests: `sha256` of `canvas.toPlain().join("\n")` and
 *     `canvas.toLines(theme).join("\n")` — the two byte surfaces the page hands
 *     to the host (`view.ts` renders `toLines(theme)` then `paintPageFloor`).
 *     They are gated against `bench/perf-core/10-baseline.json`, captured on the
 *     pre-#364 rendering code, so "the numbers moved but the page did not" is
 *     machine-checkable. `paintPageFloor` is not in the digest on purpose: it is
 *     frozen by #308's contract and touches nothing this change owns.
 *
 * The frame is the production shape: `renderLegionView(data, state, cols, rows)`
 * on a state object the caller keeps (like `createLegionViewFactory` does) +
 * `toLines(theme)`. Theme = the real `Theme(dark)` by absolute deep import (the
 * package entry does not re-export `getThemeByName`), pinned to truecolor so the
 * digest is not a function of the caller's `COLORTERM`.
 *
 * Run:
 *   node --expose-gc --experimental-strip-types bench/perf-core/10-legion-frame-alloc.ts
 *   node --expose-gc --experimental-strip-types bench/perf-core/10-legion-frame-alloc.ts --write-baseline
 *
 * `--write-baseline` captures the current render as the digest golden (that is
 * how `10-baseline.json` was produced, BEFORE any `src/` change) and exits 0;
 * a plain run gates against the file and sets `process.exitCode = 1` on a miss
 * (the `gates()` shape of `09-legion-mount.ts:358-406`).
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { Canvas } from "../../src/tui/viz/canvas.ts";
import { computeLayout } from "../../src/tui/viz/layout.ts";
import type { VizNode } from "../../src/tui/viz/model.ts";
import type { VizTheme } from "../../src/tui/viz/palette.ts";
import {
	buildLog,
	drawChart,
	drawGalaxy,
	frame,
	type ViewData,
} from "../../src/tui/viz/panels.ts";
import { RateSampler } from "../../src/tui/viz/rate.ts";
import { initialViewState, renderLegionView } from "../../src/tui/viz/view.ts";

// ------------------------------------------------------------------ the theme

/**
 * pi-tui resolves the palette mode from the terminal capabilities on first use,
 * so pinning `COLORTERM` before the theme is built keeps the escape bytes — and
 * therefore the digests — identical on a plain ssh box. A non-truecolor theme
 * fails the `theme truecolor` gate below instead of silently rewriting goldens.
 */
if (!/true/i.test(process.env.COLORTERM ?? "")) process.env.COLORTERM = "truecolor";

const THEME_URL = new URL(
	"../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js",
	import.meta.url,
);
const themeModule = (await import(THEME_URL.href)) as { getThemeByName(name: string): VizTheme | undefined };
const resolvedTheme = themeModule.getThemeByName("dark");
if (!resolvedTheme) throw new Error(`real theme "dark" not found at ${THEME_URL.pathname}`);
const theme: VizTheme = resolvedTheme;
const TRUECOLOR = /^\u001b\[38;2;\d+;\d+;\d+m/.test(theme.fg("accent", "x"));

const BASELINE_PATH = new URL("./10-baseline.json", import.meta.url);
const WRITE_BASELINE = process.argv.includes("--write-baseline");

// ------------------------------------------------------------------ the frame

const T0 = 1_700_000_000_000;
const sec = (s: number): number => T0 + s * 1_000;
const ROLES = ["worker", "scout", "planner", "reviewer", "designer", "advisor"] as const;
/** 200 agents + the ledger root, the size the issue's targets are stated for. */
const AGENTS = 200;
/** 61 samples @2s = the 120s window a live chart paints. */
const SAMPLE_EVERY_S = 2;
const SAMPLES = 61;
const END_SEC = (SAMPLES - 1) * SAMPLE_EVERY_S;

type Variant = "live" | "settled";

interface Spec {
	id: string;
	role: string;
	parent: string;
	start: number;
	/** `-1` = never ends (the `live` frame); otherwise the run's end, in seconds. */
	end: number;
	failed: boolean;
	rate: number;
}

/**
 * Deterministic 200-agent payload: six agent types, a root + a depth-2 branch
 * (`worker-0`), staggered starts so the chart has a ramp, a token rate per node,
 * and a `failed` minority so the galaxy has its ✗ labels. `live` = everything
 * still running at `now`; `settled` = everything finished 40s after its start,
 * i.e. the same tree painted by a run that is over (the second frame shape the
 * contract asks for).
 */
function scenario(variant: Variant): ViewData {
	const sampler = new RateSampler();
	const specs: Spec[] = Array.from({ length: AGENTS }, (_, i) => {
		const role = ROLES[i % ROLES.length]!;
		const start = 10 + i * 0.5;
		return {
			id: `${role}-${i}`,
			role,
			parent: i > 5 && i % 2 === 0 ? "worker-0" : "root",
			start,
			end: variant === "settled" ? start + 40 : -1,
			failed: i % 7 === 3,
			rate: 100 + (i % 17) * 10,
		};
	});
	const snap = (t: number): VizNode[] => [
		{
			id: "root",
			name: "legion-0",
			role: "legion",
			parentId: null,
			depth: 0,
			status: "running",
			startedAt: T0,
			tokens: 0,
			tokensOut: 0,
			generationMs: 0,
		},
		...specs
			.filter((spec) => spec.start <= t)
			.map((spec): VizNode => {
				const done = spec.end > 0 && t >= spec.end;
				const until = done ? spec.end : t;
				return {
					id: spec.id,
					name: spec.id,
					role: spec.role,
					parentId: spec.parent,
					depth: spec.parent === "root" ? 1 : 2,
					status: done ? (spec.failed ? "failed" : "settled") : "running",
					startedAt: sec(spec.start),
					...(done ? { endedAt: sec(until) } : {}),
					tokens: Math.round(spec.rate * (until - spec.start)),
					tokensOut: Math.round(spec.rate * (until - spec.start)),
					generationMs: Math.round((until - spec.start) * 1_000),
				};
			}),
	];
	for (let i = 0; i < SAMPLES; i++) sampler.record(sec(i * SAMPLE_EVERY_S), snap(i * SAMPLE_EVERY_S));
	const now = sec(END_SEC);
	const nodes = snap(END_SEC);
	return { nodes, sampler, now, rate: sampler.nowRate(now, nodes) };
}

/**
 * The production frame, exactly as `createLegionViewFactory().render()` builds it:
 * ONE canvas held across frames (repainted through `reset()`, #364 A5) +
 * `toLines(theme)`. Before #364 S3 that grid was a fresh `new Canvas(W, H)` every
 * frame, which is what the pre-change numbers in `10-baseline.json` paid.
 *
 * `paintPageFloor` is deliberately outside the measurement: #308 freezes it and
 * the visible-output golden anchors the same canvas-level surface, so wrapping it
 * in would only add bytes no change here may touch.
 */
function makeFrame(data: ViewData, cols: number, rows: number, state = initialViewState()): () => Canvas {
	const canvas = new Canvas(cols, rows);
	return () => {
		renderLegionView(data, state, cols, rows, canvas).canvas.toLines(theme);
		return canvas;
	};
}

// -------------------------------------------------------------- statistics

function median(xs: readonly number[]): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? (s[mid] as number) : (((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

/** Nearest-rank percentile: the smallest sample at or above `p`. */
function percentile(xs: readonly number[], p: number): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] as number;
}

const round = (n: number): number => Math.round(n * 1_000) / 1_000;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function gcNow(): void {
	const gc = (globalThis as { gc?: () => void }).gc;
	if (!gc) throw new Error("run with --expose-gc (contract §4.1)");
	gc();
	gc();
}

const SAMPLES_GC = 20;

/**
 * Median heap growth of ONE frame, in KB: full GC, read, render one frame, read.
 * The frame stays reachable across the second read, so its own output counts —
 * this is "what a frame costs the heap", not "what survives a GC".
 */
function frameAllocKB(run: () => unknown): number {
	for (let i = 0; i < 3; i++) run();
	const deltas: number[] = [];
	for (let i = 0; i < SAMPLES_GC; i++) {
		gcNow();
		const before = process.memoryUsage().heapUsed;
		const keep = run();
		const after = process.memoryUsage().heapUsed;
		if (keep === undefined) throw new Error("alloc probe returned nothing to keep alive");
		deltas.push((after - before) / 1024);
	}
	return median(deltas);
}

const ROUNDS = 5;
const FRAMES = 50;

interface Timing {
	median: number;
	p95: number;
	perRoundMedian: number[];
	perRoundP95: number[];
}

function timeFrame(run: () => unknown): Timing {
	for (let i = 0; i < 5; i++) run();
	const all: number[] = [];
	const perRoundMedian: number[] = [];
	const perRoundP95: number[] = [];
	for (let r = 0; r < ROUNDS; r++) {
		const samples: number[] = [];
		for (let i = 0; i < FRAMES; i++) {
			const started = performance.now();
			run();
			samples.push(performance.now() - started);
		}
		all.push(...samples);
		perRoundMedian.push(round(median(samples)));
		perRoundP95.push(round(percentile(samples, 0.95)));
	}
	return { median: round(median(all)), p95: round(percentile(all, 0.95)), perRoundMedian, perRoundP95 };
}

interface FrameCell {
	frameAllocKB: number;
	medianMs: number;
	p95Ms: number;
	perRoundMedianMs: number[];
	perRoundP95Ms: number[];
	plainDigest: string;
	ansiDigest: string;
}

interface Digest {
	plainDigest: string;
	ansiDigest: string;
}

function measureFrame(data: ViewData, cols: number, rows: number): FrameCell {
	const canvas = makeFrame(data, cols, rows)();
	const plainDigest = sha256(canvas.toPlain().join("\n"));
	const ansiDigest = sha256(canvas.toLines(theme).join("\n"));
	const timing = timeFrame(makeFrame(data, cols, rows));
	// Fresh state per alloc probe so the clamp offsets are settled, not warm-up.
	const alloc = frameAllocKB(makeFrame(data, cols, rows, initialViewState()));
	return {
		frameAllocKB: round(alloc),
		medianMs: timing.median,
		p95Ms: timing.p95,
		perRoundMedianMs: timing.perRoundMedian,
		perRoundP95Ms: timing.perRoundP95,
		plainDigest,
		ansiDigest,
	};
}

/**
 * Component attribution for one frame. Every probe is measured on its own (same
 * 20-sample median), so the numbers overlap by design — `residualKB` records how
 * well they add up instead of hiding the noise.
 *
 * `residualKB` = the measured whole frame MINUS (galaxy + chart + toLines +
 * canvas). It is deliberately not `renderView + toLines - sumKB`: that was an
 * algebraic identity and could only ever print 0. This one is only 0 if the four
 * probes happen to account for the frame exactly. It comes out negative here,
 * and that is the S3 result, not a bug: `canvasKB` is a `new Canvas(W,H)` per
 * frame, which the production frame no longer allocates — so the sum correctly
 * over-counts by it. Reported for attribution, never gated.
 */
interface Components {
	canvasKB: number;
	renderViewKB: number;
	galaxyKB: number;
	chartKB: number;
	toLinesKB: number;
	otherKB: number;
	residualKB: number;
}

function measureComponents(data: ViewData, cols: number, rows: number, frameKB: number): Components {
	const layout = computeLayout(cols, rows, { logEvents: buildLog(data.nodes).length });
	const reuse = new Canvas(cols, rows);
	const state = initialViewState();
	const galaxy = (): unknown => {
		const rect = frame(reuse, layout.galaxy, "galaxy", false);
		drawGalaxy(reuse, rect, data, undefined);
		return rect;
	};
	const chart = (): unknown => {
		const rect = frame(reuse, layout.chart, "tok/s", false);
		drawChart(reuse, rect, data, undefined, layout.kind !== "portrait");
		return rect;
	};
	const painted = makeFrame(data, cols, rows)();
	const toLines = (): unknown => painted.toLines(theme);
	// What one `new Canvas(W, H)` still costs — reported, not paid: the production
	// frame keeps its grid (#364 S3 / contract A5).
	const canvasKB = round(frameAllocKB(() => new Canvas(cols, rows)));
	const renderViewKB = frameAllocKB(() => renderLegionView(data, state, cols, rows, reuse));
	const galaxyKB = round(frameAllocKB(galaxy));
	const chartKB = round(frameAllocKB(chart));
	const toLinesKB = round(frameAllocKB(toLines));
	const otherKB = round(renderViewKB - galaxyKB - chartKB);
	return {
		canvasKB,
		renderViewKB: round(renderViewKB),
		galaxyKB,
		chartKB,
		toLinesKB,
		otherKB,
		residualKB: round(frameKB - (galaxyKB + chartKB + toLinesKB + canvasKB)),
	};
}

// ---------------------------------------------------------------- the matrix

/** Gated sizes (§0) — both are measured for allocation and time. */
const SIZES: ReadonlyArray<readonly [number, number]> = [
	[120, 40],
	[200, 60],
];
/** Digest-only shapes: the four the visible-output golden covers (§4.2). */
const DIGEST_SIZES: ReadonlyArray<readonly [number, number]> = [...SIZES, [80, 24], [46, 60]];
const VARIANTS: readonly Variant[] = ["live", "settled"];

const data: Record<Variant, ViewData> = { live: scenario("live"), settled: scenario("settled") };
const frames: Record<string, FrameCell> = {};
const digests: Record<string, Digest> = {};
const components: Record<string, Components> = {};
const timings: Record<string, Timing> = {};

for (const [cols, rows] of DIGEST_SIZES) {
	for (const variant of VARIANTS) {
		const tag = `${cols}x${rows}/${variant}`;
		const canvas = makeFrame(data[variant], cols, rows)();
		digests[tag] = {
			plainDigest: sha256(canvas.toPlain().join("\n")),
			ansiDigest: sha256(canvas.toLines(theme).join("\n")),
		};
	}
}
for (const [cols, rows] of SIZES) {
	for (const variant of VARIANTS) {
		const tag = `${cols}x${rows}/${variant}`;
		const { plainDigest, ansiDigest, ...rest } = measureFrame(data[variant], cols, rows);
		frames[tag] = { ...rest, plainDigest, ansiDigest };
		timings[tag] = {
			median: rest.medianMs,
			p95: rest.p95Ms,
			perRoundMedian: rest.perRoundMedianMs,
			perRoundP95: rest.perRoundP95Ms,
		};
		components[tag] = measureComponents(data[variant], cols, rows, frames[tag]!.frameAllocKB);
	}
}

// ------------------------------------------------------------------ the gates

interface Gate {
	gate: string;
	ok: boolean;
	actual: number | string;
	limit: number | string;
}

const gates: Gate[] = [];
const gate = (name: string, ok: boolean, actual: number | string, limit: number | string): void => {
	gates.push({ gate: name, ok, actual, limit });
};

gate("theme renders truecolor", TRUECOLOR, TRUECOLOR ? "truecolor" : "other", "truecolor");
gate("120x40 live frameAllocKB<=2048", frames["120x40/live"]!.frameAllocKB <= 2048, frames["120x40/live"]!.frameAllocKB, 2048);
gate("200x60 live frameAllocKB<=2048", frames["200x60/live"]!.frameAllocKB <= 2048, frames["200x60/live"]!.frameAllocKB, 2048);
gate("120x40 live medianMs<=4.0", frames["120x40/live"]!.medianMs <= 4, frames["120x40/live"]!.medianMs, 4);
gate("120x40 live p95Ms<=7.0", frames["120x40/live"]!.p95Ms <= 7, frames["120x40/live"]!.p95Ms, 7);
gate("200x60 live medianMs<=7.0", frames["200x60/live"]!.medianMs <= 7, frames["200x60/live"]!.medianMs, 7);
gate("200x60 live p95Ms<=10.0", frames["200x60/live"]!.p95Ms <= 10, frames["200x60/live"]!.p95Ms, 10);

interface Baseline {
	issue: string;
	capturedFrom: string;
	node: string;
	themeMode: string;
	agents: number;
	method: string;
	digests: Record<string, Digest>;
	/** The numbers on the capture box at capture time — context, never a gate. */
	metrics: Record<string, { frameAllocKB: number; medianMs: number; p95Ms: number }>;
	metricsNote: string;
}

const baseline: Baseline = {
	issue: "#364 / docs/contracts/viz-frame-alloc-v1.md",
	capturedFrom: "f989d0a — the rendering code the contract froze (identical to master 6042686)",
	node: process.version,
	themeMode: TRUECOLOR ? "truecolor" : "other",
	agents: AGENTS,
	method:
		"frameAllocKB = median of 20 (gc; heapUsed; renderLegionView(...).canvas.toLines(theme); heapUsed) single-frame deltas; " +
		"medianMs/p95Ms = 5 rounds x 50 frames, nearest-rank p95; digests = sha256 of toPlain().join(\"\\n\") / toLines(real dark).join(\"\\n\")",
	digests,
	metricsNote:
		"captured at the S0 commit, when a frame still allocated its own Canvas(W,H) per frame — i.e. the pre-#364-S3 render path. Reported for context only; the gates are the digests plus the §0 limits applied to the current frame.",
	metrics: Object.fromEntries(
		Object.entries(frames).map(([tag, cell]) => [tag, { frameAllocKB: cell.frameAllocKB, medianMs: cell.medianMs, p95Ms: cell.p95Ms }]),
	),
};

let stored: Baseline | undefined;
try {
	stored = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
} catch {
	stored = undefined;
}

for (const tag of Object.keys(digests)) {
	const expected = stored?.digests?.[tag];
	const plain = digests[tag]!.plainDigest;
	const ansi = digests[tag]!.ansiDigest;
	gate(
		`${tag} plainDigest`,
		expected ? plain === expected.plainDigest : false,
		plain,
		expected?.plainDigest ?? "10-baseline.json missing (run --write-baseline)",
	);
	gate(
		`${tag} ansiDigest`,
		expected ? ansi === expected.ansiDigest : false,
		ansi,
		expected?.ansiDigest ?? "10-baseline.json missing (run --write-baseline)",
	);
}

const failed = gates.filter((entry) => !entry.ok);
const report = {
	node: process.version,
	theme: { name: "dark", mode: TRUECOLOR ? "truecolor" : "other" },
	agents: AGENTS,
	sampler: { samples: SAMPLES, everySec: SAMPLE_EVERY_S, endSec: END_SEC },
	alloc: { samples: SAMPLES_GC, statistic: "median of single-frame heapUsed deltas, KB" },
	timing: { rounds: ROUNDS, framesPerRound: FRAMES, statistic: "median / nearest-rank p95 of all samples, ms" },
	frames,
	components,
	digests,
	gates,
	ok: failed.length === 0,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (WRITE_BASELINE) {
	writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
	process.stderr.write(`\n#364 baseline written to ${BASELINE_PATH.pathname}\n`);
} else if (failed.length > 0) {
	process.stderr.write(`\n#364 acceptance gate(s) missed on this box:\n${failed.map((entry) => `  - ${entry.gate}: ${entry.actual} (limit ${entry.limit})`).join("\n")}\n`);
	process.exitCode = 1;
}
