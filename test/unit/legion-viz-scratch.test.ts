/**
 * #369 — `GalaxyScratch` + the reentrancy gate (`docs/contracts/galaxy-scratch-v1.md`).
 *
 * The panels' containers are a process-wide singleton, so the two painters cannot
 * be nested: a second entry would clear the containers the first one is still
 * reading (`begin`) and paint into a half-built frame. That fact used to live in a
 * comment; contract §3 turns it into a gate, and these are its tests.
 *
 * Kept in its own file so the #364 groups in `legion-viz.test.ts` — the four-shape
 * byte goldens, the per-cell digest and the reused-`px` T1 test — stay literally
 * untouched by this refactor (contract I2).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Canvas } from "../../src/tui/viz/canvas.ts";
import type { VizNode } from "../../src/tui/viz/model.ts";
import type { VizTheme } from "../../src/tui/viz/palette.ts";
import { drawChart, drawGalaxy, type ViewData } from "../../src/tui/viz/panels.ts";
import { RateSampler } from "../../src/tui/viz/rate.ts";

const T0 = 1_700_000_000_000;
const sec = (s: number): number => T0 + s * 1_000;

/** ANSI theme that echoes the token name, so a colour moving is visible in `toLines`. */
const theme: VizTheme = {
	fg: (color: string, text: string): string => `\x1b[38;5;${color.length % 200}m${text}\x1b[39m`,
	bold: (text: string): string => `\x1b[1m${text}\x1b[22m`,
	inverse: (text: string): string => `\x1b[7m${text}\x1b[27m`,
};

const ROLES = ["worker", "scout", "planner", "reviewer"] as const;

/**
 * Eight agents + a root: two levels, four roles, one failed, one settled, one
 * idle — enough for the star map's labels, the legend and the chart's bars.
 */
function scenario(): ViewData {
	const sampler = new RateSampler();
	const snap = (seconds: number): VizNode[] => {
		const nodes: VizNode[] = [
			{ id: "root", name: "legion-0", role: "centurion", parentId: null, depth: 0, status: "running", startedAt: T0, tokens: 0, tokensOut: 0, generationMs: 0 },
		];
		for (let i = 0; i < 8; i++) {
			const role = ROLES[i % ROLES.length]!;
			const status = i === 3 ? "failed" : i === 6 ? "settled" : i === 7 ? "idle" : "running";
			const tokens = 1_000 + i * 700;
			nodes.push({
				id: `${role}-${i}`,
				name: `${role}-${i}`,
				role,
				parentId: i >= 4 && i % 2 === 0 ? `${ROLES[1]}-1` : "root",
				depth: i >= 4 && i % 2 === 0 ? 2 : 1,
				status,
				startedAt: sec(1 + i),
				...(status === "running" || status === "idle" ? {} : { endedAt: sec(30) }),
				tokens,
				tokensOut: tokens,
				generationMs: Math.max(1, seconds) * 1_000,
			});
		}
		return nodes;
	};
	for (let s = 0; s <= 40; s += 2) sampler.record(sec(s), snap(s));
	const now = sec(40);
	const nodes = snap(40);
	return { nodes, sampler, now, rate: sampler.nowRate(now, nodes) };
}

const GALAXY = { x: 0, y: 0, w: 60, h: 20 } as const;
const CHART = { x: 0, y: 20, w: 60, h: 16 } as const;

const paintGalaxy = (cv: Canvas, data: ViewData): void => drawGalaxy(cv, { ...GALAXY }, data, "worker-0");
const paintChart = (cv: Canvas, data: ViewData): void => drawChart(cv, { ...CHART }, data, undefined, true);

/** The frame the panel paints onto a canvas nobody has painted into before. */
const referenceGalaxy = (data: ViewData): Canvas => {
	const cv = new Canvas(GALAXY.w, GALAXY.h);
	paintGalaxy(cv, data);
	return cv;
};
const referenceChart = (data: ViewData): Canvas => {
	const cv = new Canvas(CHART.w, CHART.h);
	paintChart(cv, data);
	return cv;
};

/**
 * Patch one canvas instance so the FIRST `set()` it receives calls `fire()` and
 * then writes normally. `text()` goes through `this.set`, so any painting at all
 * (every glyph, label and axis rule) trips the hook — which is the only way a
 * nested render can happen in production, where the panel is called from a
 * painter that is already inside it.
 */
function nestOnFirstWrite(cv: Canvas, fire: () => void): { readonly attempts: () => number } {
	const write = cv.set.bind(cv);
	let seen = 0;
	cv.set = (x, y, ch, color, style) => {
		if (seen++ === 0) fire();
		write(x, y, ch, color, style);
	};
	return { attempts: () => seen };
}

test("#369: drawGalaxy refuses a nested render, and the refusal leaves the outer frame whole (contract §3)", () => {
	const data = scenario();
	const expected = referenceGalaxy(data);

	const cv = new Canvas(GALAXY.w, GALAXY.h);
	const hook = nestOnFirstWrite(cv, () => {
		// Second entry while the first is still painting: the containers are in use.
		assert.throws(
			() => drawGalaxy(cv, { ...GALAXY }, data, "worker-0"),
			{ name: "Error", message: "viz: drawGalaxy is not reentrant" },
			"a nested drawGalaxy must throw, not repaint with a cleared scratch",
		);
		// The chart shares the scratch, so it is refused for the same reason (and
		// names itself, not the galaxy).
		assert.throws(
			() => drawChart(cv, { ...CHART }, data, undefined, true),
			{ name: "Error", message: "viz: drawChart is not reentrant" },
			"a chart painted from inside a galaxy frame must throw too",
		);
	});
	// The gate throws *before* `begin`, so the outer frame runs to completion.
	assert.doesNotThrow(() => paintGalaxy(cv, data));
	assert.ok(hook.attempts() > 1, "the hook really fired during the frame");
	assert.deepEqual(cv.toPlain(), expected.toPlain(), "the refused nested call must not disturb the outer frame's glyphs");
	assert.deepEqual(cv.toLines(theme), expected.toLines(theme), "nor its colours");

	// `finally` cleared the gate: the next frame paints as if nothing happened.
	const after = new Canvas(GALAXY.w, GALAXY.h);
	assert.doesNotThrow(() => paintGalaxy(after, data), "the gate must not stay closed after a refused nesting");
	assert.deepEqual(after.toPlain(), expected.toPlain(), "and it paints the frame a pristine run does");
	assert.deepEqual(after.toLines(theme), expected.toLines(theme));
});

test("#369: drawChart refuses a nested render, and the refusal leaves the outer frame whole (contract §3)", () => {
	const data = scenario();
	const expected = referenceChart(data);

	const cv = new Canvas(CHART.w, CHART.h);
	const hook = nestOnFirstWrite(cv, () => {
		assert.throws(
			() => drawChart(cv, { ...CHART }, data, undefined, true),
			{ name: "Error", message: "viz: drawChart is not reentrant" },
		);
		assert.throws(
			() => drawGalaxy(cv, { ...GALAXY }, data, "worker-0"),
			{ name: "Error", message: "viz: drawGalaxy is not reentrant" },
		);
	});
	assert.doesNotThrow(() => paintChart(cv, data));
	assert.ok(hook.attempts() > 1, "the hook really fired during the frame");
	assert.deepEqual(cv.toPlain(), expected.toPlain(), "the refused nested call must not disturb the outer frame's glyphs");
	assert.deepEqual(cv.toLines(theme), expected.toLines(theme), "nor its colours");

	const after = new Canvas(CHART.w, CHART.h);
	assert.doesNotThrow(() => paintChart(after, data), "the gate must not stay closed after a refused nesting");
	assert.deepEqual(after.toPlain(), expected.toPlain());
	assert.deepEqual(after.toLines(theme), expected.toLines(theme));
});

test("#369: the same frame twice through one scratch paints the same bytes (begin is idempotent, §1.3)", () => {
	// `begin` is the only reset, and it must leave every container exactly as a
	// fresh one: a container that accumulates (`g.all`, `g.roles`, the counters)
	// would make the second frame of the same input differ from the first.
	const data = scenario();
	const other = scenario();
	const first = new Canvas(GALAXY.w, GALAXY.h);
	const second = new Canvas(GALAXY.w, GALAXY.h);
	paintGalaxy(first, data);
	paintGalaxy(second, data);
	assert.deepEqual(second.toPlain(), first.toPlain(), "two identical frames, one scratch");
	assert.deepEqual(second.toLines(theme), first.toLines(theme));

	// Same for the chart, and across painters: a galaxy frame in between must not
	// leak into the chart's containers (they share `g`, not the canvas).
	const chartFirst = new Canvas(CHART.w, CHART.h);
	paintChart(chartFirst, data);
	paintGalaxy(second, other);
	const chartSecond = new Canvas(CHART.w, CHART.h);
	paintChart(chartSecond, data);
	assert.deepEqual(chartSecond.toPlain(), chartFirst.toPlain(), "a galaxy frame in between leaves no trace in the chart");
	assert.deepEqual(chartSecond.toLines(theme), chartFirst.toLines(theme));
	assert.equal(second.width, GALAXY.w);
});
