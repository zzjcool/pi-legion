/**
 * perf-core bench 9 — where `/legion` is mounted (#347).
 *
 * `/legion` used to open as a **full-screen overlay**
 * (`src/extension/legion-commands.ts`, `showOverlay(comp, { width: "100%",
 * maxHeight: "100%", anchor: "top-left" })`). pi-tui composites every overlay row
 * through `compositeTuiLine` = `extractSegments` + `sliceWithWidth` +
 * `visibleWidth`, each an `Intl.Segmenter` grapheme walk, and its width cache is
 * keyed on the *whole line*, which a live frame never repeats. The /legion page is
 * the worst possible input for that path: braille `⣿`, box `┏│┄`, blocks `█▁▂` and
 * 56–68% non-ASCII cells, so a full-screen mount pays ~183µs/row for a full screen
 * of rows (issue #347: 57–70% of the whole `renderNow` frame).
 *
 * Mounting the *same* component on the main screen (a layout child, i.e.
 * `ui.custom(factory, { overlay: false })` on the host side) removes that per-row
 * composite entirely. The detail modal opened from the page is still a 75% overlay
 * (`resolveModalOverlayOptions()`), so it keeps compositing — but it covers 15–39
 * rows, not the whole terminal, which is the point.
 *
 * This script measures both mounts on the same component + data + theme, in **one
 * TUI instance per (size, mount)**, so the "before" column stays reproducible after
 * the production switch and the modal deltas are paired against their own base:
 *
 *   - `renderNow` median / p95 per terminal size (30 frames × 5 **paired** rounds,
 *     the `written[]` buffer cleared before every frame so growth is not timed);
 *   - the extra cost of opening the 75% detail modal (60 chat items), together
 *     with a **control**: the same 75% rect filled with blank rows only. The
 *     control separates "what the modal paints" from "what compositing the rect
 *     costs" — the modal is still an overlay, so its own rows are still
 *     composited line by line, and no change to the page's mount can remove that;
 *   - bytes written per frame (the "visible bytes must not grow" gate).
 *
 * Gates (see `gates()`): the issue's median/p95 limits on the **page frame** — the
 * frame this change owns, whose issues-time POC was 1.65 / 3.84 / 6.37ms — plus the
 * byte gate and the 80×24 modal delta. The larger modal deltas are reported, not
 * gated on an absolute limit: they are bounded below by the blank-rect control,
 * which no legal implementation of #347 can move (the modal's geometry is frozen),
 * so they gate on `modalDelta - blankDelta` instead.
 *
 * Two things this script learned the hard way (#368) and now does on purpose:
 *
 * 1. **Compare paired, not across batches.** `modalDelta - blankDelta` is computed
 *    inside each round and gated on the median over 5 rounds (see `ROUNDS`).
 *    Comparing two batch medians taken a minute apart made the gate a coin flip.
 * 2. **A busy box is neither a pass nor a regression.** Before the first frame the
 *    script probes the machine (tight-loop p95/min, foreign CPU fraction from
 *    `/proc/stat`, `loadavg[0]/cpus`). When any of them says the box is not
 *    exclusively ours, every time-class gate is reported as `not judged`, the JSON
 *    `ok` is `"inconclusive"` and the process **exits 0** — with the observed
 *    `environment: { loadavg, cpus, probe }` and a one-line reason on stderr.
 *    Byte gates keep judging: bytes do not move with the clock.
 *
 * Run: node --experimental-strip-types bench/perf-core/09-legion-mount.ts
 * (must be an otherwise-idle box; see `bench/perf-core/README.md`)
 */

import { initTheme } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createLiveOverlay, resolveModalOverlayOptions, type LiveOverlaySource } from "../../src/tui/live-overlay.ts";
import { RateSampler } from "../../src/tui/viz/rate.ts";
import type { VizNode } from "../../src/tui/viz/model.ts";
import type { ViewData } from "../../src/tui/viz/panels.ts";
import { createLegionViewFactory } from "../../src/tui/viz/view.ts";
import {
	collectEnvironment,
	judgeEnvironment,
	judgeSlack,
	median,
	percentile,
	summarizeGates,
	summarizeSlack,
	type EnvironmentVerdict,
	type Gate,
	type SlackSummary,
	type Verdict,
} from "./lib/mount-gate.ts";

// Chat-item rendering reads the host theme singleton; the bench is not a Pi process.
initTheme("dark");

class FakeTerminal implements Terminal {
	readonly written: string[] = [];
	rows: number;
	cols: number;
	constructor(rows: number, cols: number) {
		this.rows = rows;
		this.cols = cols;
	}
	start(): void {}
	stop(): void {}
	write(data: string): void {
		this.written.push(data);
	}
	get columns(): number {
		return this.cols;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
	drainInput(): Promise<void> {
		return Promise.resolve();
	}
}

/** Production-shaped theme: real escape wrappers, and a page-floor bg (see `paintPageFloor`). */
const PAGE_FLOOR_ANSI = "\u001b[48;5;236m";
const pageTheme = {
	fg: (color: string, text: string): string => `\u001b[38;5;${(color.length % 200) + 20}m${text}\u001b[39m`,
	bg: (_color: string, text: string): string => `${PAGE_FLOOR_ANSI}${text}\u001b[49m`,
	bold: (text: string): string => `\u001b[1m${text}\u001b[22m`,
	inverse: (text: string): string => `\u001b[7m${text}\u001b[27m`,
};
const modalTheme = {
	fg: (color: "accent" | "dim" | "success" | "error", text: string): string =>
		`\u001b[38;5;${color.length + 20}m${text}\u001b[39m`,
};

const T0 = 1_700_000_000_000;
const NOW = T0 + 180_000;

/** 12 nodes: a root, two centurions, their workers/scouts — the issue's frame shape. */
function buildView(): ViewData {
	const sampler = new RateSampler();
	const t0 = T0;
	const sec = (s: number): number => t0 + s * 1_000;
	const node = (id: string, opts: Partial<VizNode> = {}): VizNode => ({
		id,
		name: id.replace(/^root\./, "").replace(/\./g, "-"),
		role: "worker",
		parentId: "root",
		depth: 1,
		status: "running",
		startedAt: t0,
		tokens: 0,
		tokensOut: 0,
		generationMs: 0,
		...opts,
	});
	const nodes: VizNode[] = [
		node("root", { role: "legion", parentId: null, depth: 0, name: "legion-0" }),
		node("root.centurion-a", { role: "centurion", startedAt: sec(2), tokens: 9_000, tokensOut: 4_200, generationMs: 90_000 }),
		node("root.centurion-b", { role: "centurion", startedAt: sec(6), tokens: 7_100, tokensOut: 3_100, generationMs: 80_000 }),
		node("root.centurion-a.worker-0", { role: "worker", parentId: "root.centurion-a", depth: 2, startedAt: sec(8), tokens: 4_200, tokensOut: 2_400, generationMs: 60_000 }),
		node("root.centurion-a.worker-1", { role: "worker", parentId: "root.centurion-a", depth: 2, startedAt: sec(12), tokens: 3_900, tokensOut: 1_900, generationMs: 55_000 }),
		node("root.centurion-a.scout-0", { role: "scout", parentId: "root.centurion-a", depth: 2, status: "settled", startedAt: sec(9), endedAt: sec(40), tokens: 1_200, tokensOut: 700, generationMs: 25_000 }),
		node("root.centurion-b.worker-2", { role: "worker", parentId: "root.centurion-b", depth: 2, startedAt: sec(20), tokens: 3_100, tokensOut: 1_500, generationMs: 45_000 }),
		node("root.centurion-b.worker-3", { role: "worker", parentId: "root.centurion-b", depth: 2, startedAt: sec(24), tokens: 2_800, tokensOut: 1_300, generationMs: 40_000 }),
		node("root.centurion-b.scout-1", { role: "scout", parentId: "root.centurion-b", depth: 2, startedAt: sec(26), tokens: 900, tokensOut: 400, generationMs: 18_000 }),
		node("root.centurion-b.worker-4", { role: "worker", parentId: "root.centurion-b", depth: 2, status: "settled", startedAt: sec(30), endedAt: sec(120), tokens: 2_400, tokensOut: 1_100, generationMs: 35_000 }),
		node("root.centurion-a.worker-5", { role: "worker", parentId: "root.centurion-a", depth: 2, status: "idle", startedAt: sec(34), tokens: 1_800, tokensOut: 800, generationMs: 30_000 }),
		node("root.centurion-a.worker-6", { role: "worker", parentId: "root.centurion-a", depth: 2, status: "failed", startedAt: sec(38), endedAt: sec(140), tokens: 1_400, tokensOut: 600, generationMs: 22_000 }),
	];
	// A few real samples so the chart has a series to bucket and paint.
	for (const t of [0, 4, 8, 12, 16, 20, 24, 28]) sampler.record(sec(t * 5), nodes);
	return { nodes, sampler, now: NOW, rate: 42 };
}

/** 60 chat items of live-looking output, the issue's modal payload. */
function modalMessages(): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (let i = 0; i < 30; i++) {
		messages.push({
			role: "user",
			content: `▸ request ${i + 1}: investigate the slow render path in panes ${i}`,
			timestamp: T0 + i * 2_000,
		} as AgentMessage);
		messages.push({
			role: "assistant",
			content: [{ type: "text", text: `answer ${i + 1}: ┏━━━━┓ measured ${i}µs/row, the composite is the hot path ▁▂▃▄▅` }],
			api: "openai-completions",
			provider: "openai",
			model: "test/model",
			usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: T0 + i * 2_000 + 1_000,
		} as unknown as AgentMessage);
	}
	return messages;
}

function modalSource(): LiveOverlaySource {
	const messages = modalMessages();
	return {
		subscribe: () => () => {},
		unsubscribe: () => {},
		getNode: () => ({
			id: "root.centurion-a.worker-0",
			name: "worker-0",
			role: "worker",
			model: "test/model",
			status: "running",
			parentId: "root.centurion-a",
			depth: 2,
			createdAt: T0,
			updatedAt: T0,
		}),
		backfill: () => ({
			messages,
			cursor: { turnCount: 30, assistantMessageCount: 30, messageCount: 60, fileSize: 1 },
		}),
	};
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

type Mount = "overlay" | "main";

interface LayerRound {
	framesMs: number[];
	/** Bytes the terminal accepted for one full-redraw frame. */
	bytesPerFrame: number;
}

/** One paired round: the same three layers measured back to back, on one TUI instance. */
interface TimingRound {
	/** The /legion page alone — the frame #347 changes. */
	base: LayerRound;
	/** Page + the 75% detail modal (60 chat items). */
	withModal: LayerRound;
	/** Page + an overlay of the same rect that paints nothing but blanks. */
	blankControl: LayerRound;
}

/** Frames per layer per segment. */
const SEGMENT_FRAMES = 10;
/** base → modal → blank segments per round; `SEGMENT_FRAMES × SEGMENTS = 30` frames per layer per round. */
const SEGMENTS = 3;
/**
 * Paired rounds (#368). The old shape measured all 150 base frames, then all 150
 * modal frames, then all 150 control frames, and compared two medians taken a
 * minute apart — which on a shared box moved by ±0.5ms on its own and made the
 * floor gate a coin flip (issue #368: master itself failed 2 of 3 runs). Now each
 * round interleaves base/modal/blank in three segments of 10 frames, so
 * `slack = modalDelta - blankDelta` is computed **inside each round** on
 * neighbouring samples and gated on its median. `30 × ROUNDS = 150` frames per
 * layer, the same sample count the median/p95 gates were calibrated on.
 */
const ROUNDS = 5;
const FRAMES = SEGMENT_FRAMES * SEGMENTS;

/**
 * One TUI instance per (size, mount), and inside it one instance of each layer per
 * round: base, modal and control are measured back to back, so each round's deltas
 * are paired and do not inherit cross-batch drift.
 */
function measure(rows: number, cols: number, mount: Mount): { rounds: TimingRound[] } {
	const terminal = new FakeTerminal(rows, cols);
	const tui = new TuiMainScreen(terminal, false, undefined);
	const data = buildView();
	const view = createLegionViewFactory({ getData: () => data })(tui, pageTheme, {}, () => {});
	// "before": the production mount on master (`legion-commands.ts`).
	// "after": the component as a main-screen layout child.
	if (mount === "overlay") {
		tui.showOverlay(view, { width: "100%", maxHeight: "100%", anchor: "top-left", row: 0, col: 0 });
	} else {
		tui.addChild(view);
	}

	const frame = (): { ms: number; bytes: number } => {
		terminal.written.length = 0;
		const started = performance.now();
		tui.renderNow(true);
		const ms = performance.now() - started;
		const bytes = terminal.written.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0);
		return { ms, bytes };
	};
	/** Draw `count` frames into `layer`; the byte count is one full redraw. */
	const collect = (layer: LayerRound, count: number): void => {
		for (let i = 0; i < count; i++) {
			const { ms, bytes } = frame();
			layer.framesMs.push(ms);
			layer.bytesPerFrame = Math.max(layer.bytesPerFrame, bytes);
		}
	};

	const modal = createLiveOverlay(modalSource()).open("root.centurion-a.worker-0", {
		terminalRows: rows,
		now: () => NOW,
		theme: modalTheme,
		requestRender: () => {},
	});
	// Control: the modal's exact rect with nothing painted in it. Whatever this adds
	// is the price of "a 75% overlay exists", before the modal draws a single cell.
	const blankRows = Math.max(1, Math.floor(rows * 0.65));
	const blankOverlay = {
		render: (width: number): string[] =>
			Array.from({ length: blankRows }, () => " ".repeat(Math.max(1, Math.min(width, Math.floor(cols * 0.75))))),
		invalidate: (): void => {},
	};

	const rounds: TimingRound[] = [];
	for (let r = 0; r < ROUNDS; r++) {
		if (r === 0) for (let i = 0; i < 3; i++) frame();
		const base: LayerRound = { framesMs: [], bytesPerFrame: 0 };
		const withModal: LayerRound = { framesMs: [], bytesPerFrame: 0 };
		const blankControl: LayerRound = { framesMs: [], bytesPerFrame: 0 };
		for (let segment = 0; segment < SEGMENTS; segment++) {
			collect(base, SEGMENT_FRAMES);
			// `#368`: the three layers are interleaved at segment granularity (10 frames
			// each), and the two overlays alternate their order per segment. A drift that
			// spans a few hundred ms (turbo decay, a neighbour waking up, a GC pause) then
			// lands on all three layers of the same round instead of on just the block that
			// happened to be running, which is what made the 200×60 slack swing 0.08…1.30
			// between rounds of one run.
			const modalFirst = (r + segment) % 2 === 0;
			const measureModal = (): void => {
				tui.showOverlay(modal, resolveModalOverlayOptions());
				frame();
				collect(withModal, SEGMENT_FRAMES);
				tui.hideOverlay();
			};
			const measureBlankControl = (): void => {
				tui.showOverlay(blankOverlay, resolveModalOverlayOptions());
				frame();
				collect(blankControl, SEGMENT_FRAMES);
				tui.hideOverlay();
			};
			if (modalFirst) {
				measureModal();
				measureBlankControl();
			} else {
				measureBlankControl();
				measureModal();
			}
		}
		rounds.push({ base, withModal, blankControl });
	}

	modal.dispose();
	view.dispose();
	return { rounds };
}

interface LayerStats {
	medianMs: number;
	p95Ms: number;
	perRoundMedianMs: number[];
	bytesPerFrame: number;
}

const layerStats = (rounds: readonly TimingRound[], pick: (r: TimingRound) => LayerRound): LayerStats => {
	const framesMs = rounds.flatMap((r) => pick(r).framesMs);
	return {
		medianMs: round(median(framesMs)),
		p95Ms: round(percentile(framesMs, 0.95)),
		perRoundMedianMs: rounds.map((r) => round(median(pick(r).framesMs))),
		bytesPerFrame: Math.max(...rounds.map((r) => pick(r).bytesPerFrame)),
	};
};

const SIZES: ReadonlyArray<readonly [number, number]> = [[24, 80], [40, 120], [60, 200]];

const table = SIZES.map(([rows, cols]) => {
	const size = `${cols}x${rows}`;
	const bytesGrowth = (next: number, prev: number): number => round(((next - prev) / prev) * 100);
	const cell = (mount: Mount) => {
		const { rounds } = measure(rows, cols, mount);
		const base = layerStats(rounds, (r) => r.base);
		const withModal = layerStats(rounds, (r) => r.withModal);
		const blankControl = layerStats(rounds, (r) => r.blankControl);
		const slack: SlackSummary = summarizeSlack(
			rounds.map((r) => ({ baseMs: r.base.framesMs, modalMs: r.withModal.framesMs, blankMs: r.blankControl.framesMs })),
		);
		return {
			base,
			withModal,
			blankControl,
			// Paired medians: the old reported numbers, now taken per round instead of
			// from three far-apart batches.
			modalDeltaMedianMs: slack.modalDeltaMedianMs,
			blankControlDeltaMedianMs: slack.blankControlDeltaMedianMs,
			slack,
		};
	};
	const before = cell("overlay");
	const after = cell("main");
	return {
		size,
		mount: { overlay: before, main: after },
		speedup: {
			base: round(before.base.medianMs / after.base.medianMs),
			withModal: round(before.withModal.medianMs / after.withModal.medianMs),
		},
		bytesGrowthPct: {
			base: bytesGrowth(after.base.bytesPerFrame, before.base.bytesPerFrame),
			withModal: bytesGrowth(after.withModal.bytesPerFrame, before.withModal.bytesPerFrame),
		},
	};
});

/**
 * The environment probe runs **before** the first frame: `npm test` in another
 * pane, a co-tenant, or a stale `loadavg` from earlier work are all things that
 * make a 30s frame benchmark measure the neighbours. When it says the box is not
 * exclusively ours, every time-class gate below reports `not judged` and the run
 * ends `ok: "inconclusive"` with exit code 0 — a busy box is not a regression, and
 * it is not a pass either.
 */
const environment = await collectEnvironment();
const envVerdict: EnvironmentVerdict = judgeEnvironment(environment);

/**
 * Paired-slack gate limit, in ms (#368).
 *
 * The statement is unchanged from the mount contract: "opening the detail modal
 * may cost at most the same rect painted blank, plus a margin". Only the statistic
 * changed (`modalDelta - blankDelta` **inside each round**, median over 5 rounds).
 *
 * The margin is derived from the measured distribution, not chosen: 8 idle runs of
 * this script (5 paired rounds each, `reports/368-mount-gate.md`) gave
 *
 *   | size   | per-round slack p50 / p95 | per-run median slack |
 *   |--------|---------------------------|----------------------|
 *   | 80×24  | 0.23 / 0.33 ms            | 0.17 – 0.28 ms       |
 *   | 120×40 | 0.34 / 0.60 ms            | 0.33 – 0.45 ms       |
 *   | 200×60 | 0.46 / 0.87 ms            | 0.42 – 0.61 ms       |
 *
 * so the upper bound of the noise is 0.87 ms (200×60, where the modal's 39 rows
 * cost more to composite than 39 blank rows — that is the physical floor, and it
 * grows with the rect). `max(observed upper bound, 0.5 ms)`, rounded up to the next
 * 0.1 ms, is **0.9 ms**. One epsilon for every size, as the contract always had.
 *
 * This does not mute the gate: the slack is what the modal adds *beyond* the
 * blank-rect floor, so a modal that went back to compositing like the page would
 * add the 1.3–5.3 ms the whole modal delta is — 1.5–6× this limit.
 */
const SLACK_LIMIT_MS = 0.9;

/**
 * Build one gate. Time-class gates are `not judged` when the environment probe
 * says the box is busy; byte/structure gates are always judged, because a byte
 * count does not move with the clock.
 */
const gateOf = (
	gate: string,
	kind: Gate["kind"],
	verdict: Verdict,
	actual: number | string,
	limit: number | string,
	note?: string,
): Gate => {
	if (kind === "time" && !envVerdict.satisfied) {
		return { gate, kind, ok: null, judged: false, actual, limit, note: envVerdict.reason };
	}
	if (verdict === "inconclusive") {
		return { gate, kind, ok: null, judged: false, actual, limit, ...(note === undefined ? {} : { note }) };
	}
	return { gate, kind, ok: verdict, judged: true, actual, limit, ...(note === undefined ? {} : { note }) };
};

/**
 * Acceptance gates from issue #347, re-based on #368.
 *
 * The median/p95 limits are applied to the **page frame** — the frame this change
 * owns, and the one the issue's POC timed (1.65 / 3.84 / 6.37ms); the limits are that
 * POC +30% (median) and ≈2× (p95). The with-modal frame is reported but not gated on
 * those numbers: most of its cost is compositing the modal's own 26 / 39 rows, which
 * the change neither removes nor may remove (the modal stays a 75% overlay).
 *
 * The frozen "opening the detail modal adds ≤2.0ms/frame" limit is applied where the
 * modal is 15 rows tall (80×24 — the size the issue's own +2.086ms delta came from).
 * It is not applied at 120×40 / 200×60 because it is unreachable there by
 * construction: the blank-rect control (an overlay of the same rect that paints
 * nothing) already exceeds it. Those rows gate on `modalDelta - blankDelta` instead,
 * so a reader can see the whole delta is the modal's own composite, not the page.
 */
const gates: Gate[] = table.flatMap((row) => {
	const after = row.mount.main;
	const out: Gate[] = [];
	if (row.size === "120x40") {
		out.push(gateOf(`${row.size} page medianMs<=5.0`, "time", after.base.medianMs <= 5, after.base.medianMs, 5));
		out.push(gateOf(`${row.size} page p95Ms<=8.0`, "time", after.base.p95Ms <= 8, after.base.p95Ms, 8));
	}
	if (row.size === "200x60") {
		out.push(gateOf(`${row.size} page medianMs<=9.0`, "time", after.base.medianMs <= 9, after.base.medianMs, 9));
		out.push(gateOf(`${row.size} page p95Ms<=14.0`, "time", after.base.p95Ms <= 14, after.base.p95Ms, 14));
	}
	if (row.size === "80x24") {
		out.push(gateOf(`${row.size} modalDeltaMedianMs<=2.0`, "time", after.modalDeltaMedianMs <= 2, after.modalDeltaMedianMs, 2));
	}
	const slackVerdict = judgeSlack(after.slack, SLACK_LIMIT_MS);
	out.push(
		gateOf(
			`${row.size} modalSlackWithinBlankRectFloor<=${SLACK_LIMIT_MS}`,
			"time",
			slackVerdict.ok,
			after.slack.slackMedianMs,
			SLACK_LIMIT_MS,
			slackVerdict.reason,
		),
	);
	out.push(gateOf(`${row.size} pageSpeedup>=2.0`, "time", row.speedup.base >= 2, row.speedup.base, 2));
	out.push(
		gateOf(
			`${row.size} bytesGrowthPct<=2.0`,
			"bytes",
			row.bytesGrowthPct.withModal <= 2 && row.bytesGrowthPct.base <= 2,
			Math.max(row.bytesGrowthPct.withModal, row.bytesGrowthPct.base),
			2,
		),
	);
	return out;
});

const verdict = summarizeGates(gates, envVerdict);
const environmentReport = {
	loadavg: environment.loadavg.map((n) => round(n)),
	cpus: environment.cpus,
	probe: environment.probe,
	satisfied: envVerdict.satisfied,
	reason: envVerdict.reason,
};

process.stdout.write(`${JSON.stringify({
	node: process.version,
	sizes: SIZES.map(([rows, cols]) => `${cols}x${rows}`),
	frames: { perRound: FRAMES, rounds: ROUNDS },
	slackLimitMs: SLACK_LIMIT_MS,
	environment: environmentReport,
	table,
	gates,
	ok: verdict.ok,
}, null, 2)}\n`);
// One prominent line regardless of outcome: a reader must never have to guess
// whether a green-ish JSON meant "passed" or "not judged".
process.stderr.write(`\n#368 ${verdict.summary}\n`);
if (verdict.ok === false) process.exitCode = 1;
