import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { displayStatus, nodesFromEntries, type VizNode } from "../../src/tui/viz/model.ts";
import { FALLBACK_TOKENS, nodeToken, resolveRolePalette, roleColor, roleToken, swatchesClash, tokenSwatch } from "../../src/tui/viz/palette.ts";
import { RateSampler, RATE_WINDOW_MS } from "../../src/tui/viz/rate.ts";
import { assignLanes, axisColumn, liveAt, maxLanesFor, renderRailway, resolveScroll, scrollIndicator } from "../../src/tui/viz/railway.ts";
import { computeLayout, selectLayout } from "../../src/tui/viz/layout.ts";
import { buildLog, computeStats } from "../../src/tui/viz/panels.ts";
import { createLegionViewFactory, handleViewKey, initialViewState, renderLegionView } from "../../src/tui/viz/view.ts";
import { ellipsize } from "../../src/tui/viz/canvas.ts";
import { createStatusBoard, type StatusEntry, type StatusUi, type WidgetFactory } from "../../src/tui/status.ts";

const T0 = 1_700_000_000_000;
const sec = (s: number): number => T0 + s * 1000;

function node(id: string, opts: Partial<VizNode> = {}): VizNode {
	return { id, name: id, role: id.replace(/-\d+$/, ""), parentId: "root", depth: 1, status: "running", startedAt: T0, tokens: 0, tokensOut: 0, generationMs: 0, ...opts };
}
const ROOT = node("root", { name: "centurion-0", role: "centurion", parentId: null, depth: 0 });

const plainTheme = { fg: (_c: string, text: string) => text };
const ansiTheme = {
	fg: (c: string, text: string) => `\x1b[38;5;${c.length % 200}m${text}\x1b[39m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
};

/** Deterministic scenario: agents with steady token rates over 10 minutes. */
function scenario(endSec = 600, count = 12): { nodes: VizNode[]; sampler: RateSampler; now: number } {
	const specs = Array.from({ length: count }, (_, i) => {
		const role = ["worker", "scout", "planner", "reviewer", "designer"][i % 5]!;
		const start = 10 + i * 40;
		const end = i % 3 === 0 ? start + 200 : null;
		return { id: `${role}-${i}`, role, start, end, failed: i === 6, parent: i > 3 && i % 2 === 0 ? `worker-0` : "root", rate: 100 + i * 10 };
	});
	const sampler = new RateSampler();
	const snap = (t: number): VizNode[] => [ROOT, ...specs.filter((s) => s.start <= t).map((s) => {
		const done = s.end !== null && t >= s.end;
		return node(s.id, {
			role: s.role,
			parentId: s.parent,
			depth: s.parent === "root" ? 1 : 2,
			status: done ? (s.failed ? "failed" : "settled") : "running",
			startedAt: sec(s.start),
			...(done ? { endedAt: sec(s.end!) } : {}),
			tokens: Math.round(s.rate * ((done ? s.end! : t) - s.start)),
			// Steady generation: output rate == wall rate when genMs tracks elapsed.
			tokensOut: Math.round(s.rate * ((done ? s.end! : t) - s.start)),
			generationMs: Math.round(((done ? s.end! : t) - s.start) * 1000),
		});
	})];
	for (let t = 0; t <= endSec; t += 2) sampler.record(sec(t), snap(t));
	return { nodes: snap(endSec), sampler, now: sec(endSec) };
}

test("viz: blocked and starting display as running; terminal states map to done/failed/retired", () => {
	assert.equal(displayStatus("starting"), "running");
	assert.equal(displayStatus("blocked"), "running");
	assert.equal(displayStatus("running"), "running");
	assert.equal(displayStatus("working"), "running");
	// Matches the footer's active set: an idle/awaiting child is not counted as live.
	assert.equal(displayStatus("idle"), "retired");
	assert.equal(displayStatus("awaiting"), "retired");
	assert.equal(displayStatus("settled"), "settled");
	assert.equal(displayStatus("failed"), "failed");
	assert.equal(displayStatus("retired"), "retired");
});

test("viz: role colors are theme tokens; unknown roles pick a stable syntax token", () => {
	assert.equal(roleToken("centurion"), "accent");
	assert.equal(roleToken("planner"), "syntaxKeyword");
	assert.equal(roleToken("worker"), "syntaxVariable");
	assert.equal(roleToken("scout"), "syntaxNumber");
	assert.equal(roleToken("reviewer"), "syntaxFunction");
	assert.equal(roleToken("advisor"), "syntaxString");
	const custom = roleToken("quantum-tinkerer");
	assert.ok((FALLBACK_TOKENS as readonly string[]).includes(custom));
	assert.equal(roleToken("quantum-tinkerer"), custom);
	assert.equal(nodeToken({ role: "worker", status: "failed" }), "error");
	assert.equal(nodeToken({ role: "worker", status: "retired" }), "dim");
	assert.equal(nodeToken({ role: "worker", status: "settled" }), "role:worker");
});

test("viz: nodesFromEntries keeps tree identity and reattaches orphans", () => {
	const entries: StatusEntry[] = [
		{ name: "centurion-0", agent: "centurion", state: "running", startedAt: T0, nodeId: "root", parentId: null, depth: 0 },
		{ name: "w", agent: "worker", state: "blocked", startedAt: T0, nodeId: "root.w", parentId: "root", depth: 1, tokensTotal: 50 },
		{ name: "s", agent: "scout", state: "settled", startedAt: T0, finishedAt: T0 + 5, nodeId: "root.x.s", parentId: "root.x", depth: 2 },
	];
	const nodes = nodesFromEntries(entries);
	assert.equal(nodes.find((n) => n.id === "root.w")?.status, "running");
	assert.equal(nodes.find((n) => n.id === "root.w")?.tokens, 50);
	const s = nodes.find((n) => n.id === "root.x.s")!;
	assert.equal(s.parentId, "root");
	assert.equal(s.endedAt, T0 + 5);
});

test("railway: lanes compact when an agent ends (no empty rows, lower lanes shift up)", () => {
	const nodes = [ROOT,
		node("worker-1", { startedAt: sec(0) }),
		node("worker-2", { startedAt: sec(10), status: "settled", endedAt: sec(50) }),
		node("worker-3", { startedAt: sec(20) }),
	];
	const before = assignLanes(nodes, sec(30), 4);
	assert.deepEqual([...before.lanes.entries()], [["worker-1", 0], ["worker-2", 1], ["worker-3", 2]]);
	const after = assignLanes(nodes, sec(60), 4);
	assert.deepEqual([...after.lanes.entries()], [["worker-1", 0], ["worker-3", 1]]);
});

test("railway: lane priority is oldest then shallowest, overflow scrolls with a range indicator", () => {
	const nodes = [ROOT,
		node("deep", { startedAt: sec(0), depth: 3 }),
		node("shallow", { startedAt: sec(0), depth: 1 }),
		...Array.from({ length: 5 }, (_, i) => node(`w-${i}`, { startedAt: sec(1 + i) })),
	];
	const lanes = assignLanes(nodes, sec(10), 4);
	assert.deepEqual(lanes.shown.map((n) => n.id), ["shallow", "deep", "w-0", "w-1"]);
	assert.equal(lanes.hidden.length, 3);
	assert.equal(liveAt(nodes, sec(10)).length, 7);
	assert.equal(maxLanesFor(79), 3);
	assert.equal(maxLanesFor(80), 4);
	const narrow = renderRailway({ nodes, now: sec(10), width: 60, rate: 0 })!;
	assert.equal(narrow.canvas.height, 4);
	assert.match(narrow.canvas.toPlain()[0]!, / 7 live · 1-3\/7  ▼ · /);
	assert.match(narrow.canvas.toPlain()[3]!, / ▼$/);
	const wide = renderRailway({ nodes, now: sec(10), width: 120, rate: 0 })!;
	assert.equal(wide.canvas.height, 5);
	assert.match(wide.canvas.toPlain()[0]!, /legion 7 live · 1-4\/7  ▼ · /);
	assert.match(wide.canvas.toPlain()[4]!, / ▼$/);
	assert.doesNotMatch(wide.canvas.toPlain().join("\n"), /\+\d/);
	assert.deepEqual(wide.nodeIdsByRow, [undefined, "shallow", "deep", "w-0", "w-1"]);
});

test("railway: hidden entirely without live subagents", () => {
	assert.equal(renderRailway({ nodes: [ROOT], now: sec(1), width: 120, rate: 0 }), undefined);
	const ended = [ROOT, node("w", { status: "settled", endedAt: sec(5) })];
	assert.equal(renderRailway({ nodes: ended, now: sec(10), width: 120, rate: 0 }), undefined);
});

test("railway: header shows live count and shared tok/s; long names are truncated with …", () => {
	const nodes = [ROOT, node("a-very-long-agent-name-that-overflows", { role: "worker" })];
	const out = renderRailway({ nodes, now: sec(30), width: 46, rate: 1234 })!;
	const lines = out.canvas.toPlain();
	assert.match(lines[0]!, /1 live · 1\.2k tok\/s/);
	assert.match(lines[1]!, /…/);
	assert.equal(ellipsize("abcdef", 4), "abc…");
});

test("railway: rendered width never exceeds the terminal columns", () => {
	const { nodes, sampler, now } = scenario();
	for (let width = 20; width <= 220; width += 3) {
		const out = renderRailway({ nodes, now, width, rate: sampler.totalRate(now) });
		if (!out) continue;
		for (const line of out.canvas.toLines(ansiTheme)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)}`);
	}
});

test("layout: wide >= 140, stacked in between, portrait when narrow or tall", () => {
	assert.equal(selectLayout(160, 50), "wide");
	assert.equal(selectLayout(140, 40), "wide");
	assert.equal(selectLayout(139, 40), "stacked");
	assert.equal(selectLayout(100, 40), "stacked");
	assert.equal(selectLayout(90, 50), "portrait");
	assert.equal(selectLayout(79, 20), "portrait");
	assert.equal(selectLayout(60, 70), "portrait");
	assert.equal(selectLayout(46, 60), "portrait");
	// Tall terminals are portrait by aspect ratio, whatever the width.
	assert.equal(selectLayout(110, 120), "portrait");
	assert.equal(selectLayout(120, 100), "portrait");
	assert.equal(selectLayout(90, 80), "portrait");
	assert.equal(selectLayout(60, 120), "portrait");
	assert.equal(selectLayout(160, 90), "portrait");
	assert.equal(selectLayout(120, 40), "stacked");
	for (const [w, h] of [[46, 60], [60, 70], [100, 40], [160, 50]] as const) {
		const l = computeLayout(w, h);
		for (const r of [l.galaxy, l.chart, l.log]) {
			assert.ok(r.x >= 0 && r.x + r.w <= w && r.y >= 0 && r.y + r.h <= h - 1, `${w}x${h} ${JSON.stringify(r)}`);
		}
	}
});

test("rate: output over generationMs (60s window), cumulative counters never regress, late spawns start at zero", () => {
	const sampler = new RateSampler();
	for (let t = 0; t <= 300; t += 5) {
		sampler.record(sec(t), [ROOT,
			node("a", { tokensOut: 100 * t, generationMs: t * 1000 }),
			...(t >= 100 ? [node("b", { startedAt: sec(100), tokensOut: 50 * (t - 100), generationMs: (t - 100) * 1000 })] : []),
		]);
	}
	assert.ok(Math.abs(sampler.nodeRate("a", sec(300)) - 100) < 1e-6);
	assert.ok(Math.abs(sampler.totalRate(sec(300)) - 150) < 1e-6);
	assert.equal(sampler.valueAt("b", sec(100)), 0);
	assert.equal(RATE_WINDOW_MS, 60_000);
	// Cumulative counters never regress.
	sampler.record(sec(305), [node("a", { tokensOut: 10, generationMs: 10 })]);
	assert.equal(sampler.valueAt("a", sec(305)), 30_000);
	assert.equal(sampler.genAt("a", sec(305)), 300_000);
	const buckets = sampler.buckets(sec(200), sec(300), 10);
	for (const v of buckets.total) assert.ok(Math.abs(v - 150) < 1e-6);
	assert.deepEqual([...buckets.byRole.keys()].sort(), ["a", "b"]);
});

test("rate: idle/tool gaps do not dilute output tok/s (generationMs denominator)", () => {
	const sampler = new RateSampler();
	// 10s of generation producing 1000 output tokens, then 50s idle (genMs flat).
	for (let t = 0; t <= 60; t += 1) {
		const generating = t <= 10;
		sampler.record(sec(t), [ROOT, node("a", {
			tokensOut: generating ? t * 100 : 1000,
			generationMs: generating ? t * 1000 : 10_000,
		})]);
	}
	// Trailing 60s wall includes idle, but denominator is only 10s of generation → 100 tok/s.
	assert.ok(Math.abs(sampler.totalRate(sec(60)) - 100) < 1e-6);
	// Wall-clock fallback would have been 1000/60 ≈ 16.7.
	assert.ok(sampler.totalRate(sec(60)) > 50);
});

test("rate: header tok/s and chart 'now' share one definition", () => {
	const { nodes, sampler, now } = scenario();
	const rate = sampler.totalRate(now);
	const stats = computeStats({ nodes, sampler, now, rate }, 80);
	assert.equal(stats.now, rate);
	assert.ok(stats.peak >= rate);
	assert.equal(stats.total, nodes.filter((n) => n.id !== "root").reduce((s, n) => s + n.tokens, 0));
	const { canvas } = renderLegionView({ nodes, sampler, now, rate }, initialViewState(), 160, 50);
	const header = canvas.toPlain()[0]!;
	const label = rate >= 1000 ? `${(rate / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(Math.round(rate));
	assert.ok(header.includes(`${label} tok/s`), header);
});

test("legion view: no clipping at 46x60, 60x70, 100x40, 160x50 (dark/light themes alike)", () => {
	const { nodes, sampler, now } = scenario();
	const data = { nodes, sampler, now, rate: sampler.totalRate(now) };
	for (const [w, h] of [[46, 60], [60, 70], [100, 40], [160, 50], [80, 24], [139, 45]] as const) {
		for (const selected of [undefined, "worker-5"]) {
			const state = initialViewState();
			if (selected) state.selectedId = selected;
			const { canvas } = renderLegionView(data, state, w, h);
			const lines = canvas.toLines(ansiTheme);
			assert.equal(lines.length, h);
			for (const line of lines) assert.equal(visibleWidth(line), w, `${w}x${h}`);
			const plain = canvas.toLines(plainTheme).map(stripTerminalSequences);
			assert.ok(plain.some((l) => l.includes("galaxy")));
			assert.ok(plain.some((l) => l.includes("tok/s")));
			assert.ok(plain.some((l) => l.includes("log --graph")));
		}
	}
});

test("legion view: Tab cycles panes, Enter in log selects, Esc clears then exits, q exits", () => {
	const { nodes } = scenario();
	const state = initialViewState();
	assert.equal(state.focus, "galaxy");
	assert.equal(handleViewKey("\t", state, nodes), "render");
	assert.equal(state.focus, "chart");
	handleViewKey("\t", state, nodes);
	assert.equal(state.focus, "log");
	handleViewKey("\x1b[B", state, nodes);
	assert.equal(state.logCursor, 1);
	assert.equal(handleViewKey("\r", state, nodes), "render");
	assert.equal(state.selectedId, buildLog(nodes)[1]!.node.id);
	assert.equal(handleViewKey("o", state, nodes), "open");
	assert.equal(handleViewKey("\x1b", state, nodes), "render");
	assert.equal(state.selectedId, undefined);
	assert.equal(handleViewKey("\x1b", state, nodes), "close");
	state.focus = "galaxy";
	handleViewKey("\x1b[B", state, nodes);
	assert.ok(state.selectedId);
	assert.equal(handleViewKey("q", state, nodes), "close");
});

test("status board: railway strip replaces the roster when enabled and hides with no live agents", () => {
	let factory: WidgetFactory | undefined;
	const ctx: StatusUi = {
		hasUI: true,
		ui: {
			theme: plainTheme,
			setStatus() {},
			setWidget(_key, content) {
				factory = typeof content === "function" ? content : undefined;
			},
		},
	};
	const board = createStatusBoard({ strip: "railway" });
	board.bind(ctx);
	const now = Date.now();
	const entries: StatusEntry[] = [
		{ name: "centurion-0", agent: "centurion", state: "running", startedAt: now - 60_000, nodeId: "root", parentId: null, depth: 0 },
		{ name: "worker-1", agent: "worker", state: "running", startedAt: now - 30_000, nodeId: "root.worker-1", parentId: "root", depth: 1, tokensTotal: 100, tokensOut: 50, generationMs: 1_000 },
	];
	board.paint(entries, now - 1000);
	board.paint(entries.map((e) => e.nodeId === "root.worker-1" ? { ...e, tokensTotal: 700, tokensOut: 650, generationMs: 2_000 } : e), now);
	assert.ok(factory);
	const lines = factory!({ requestRender() {} }, plainTheme).render(100);
	assert.equal(lines.length, 2);
	assert.match(lines[0]!, /1 live · \d+ tok\/s/);
	assert.match(lines[1]!, /worker-1/);
	for (const line of lines) assert.ok(visibleWidth(line) <= 100);
	const snap = board.vizSnapshot!(now);
	assert.equal(snap.rate, snap.sampler.totalRate(now));
	assert.ok(snap.rate > 0);
	board.paint(entries.slice(0, 1), now + 1000);
	board.clear();
});

test("rate: chart buckets are trailing 60s averages (bursts smoothed, last bucket == header now)", () => {
	const sampler = new RateSampler();
	// Session-file usage lands in bursts: +6000 output tokens with 60s of generation.
	for (let t = 0; t <= 240; t += 2) {
		sampler.record(sec(t), [ROOT, node("a", {
			tokensOut: t >= 120 ? 6000 : 0,
			generationMs: t >= 120 ? 60_000 : 0,
		})]);
	}
	const b = sampler.buckets(sec(0), sec(240), 120);
	assert.ok(Math.max(...b.total) <= 6000 / 60 + 1e-6, `peak ${Math.max(...b.total)}`);
	const now = sec(170);
	const last = sampler.buckets(sec(0), now, 85).total.at(-1)!;
	assert.ok(Math.abs(last - sampler.totalRate(now)) < 1e-6);
});

test("legion view: root is not listed as an agent type and the factory fills the terminal height", () => {
	const { nodes, sampler, now } = scenario();
	const data = { nodes: nodes.map((n) => n.id === "root" ? { ...n, name: "root", role: "root" } : n), sampler, now, rate: sampler.totalRate(now) };
	const { canvas } = renderLegionView(data, initialViewState(), 160, 50);
	const legend = canvas.toPlain().find((l) => l.includes("⣿ worker"))!;
	assert.ok(!legend.includes("⣿ root"), legend);
	assert.equal(roleColor("root"), "text");
	const factory = createLegionViewFactory({ getData: () => data });
	const component = factory({ requestRender() {}, terminal: { rows: 37 } }, plainTheme, undefined, () => {});
	assert.equal(component.render(100).length, 37);
	component.dispose();
});

test("viz: duplicate child names from nested supervisors are disambiguated by parent", () => {
	const entries: StatusEntry[] = [
		{ name: "root", agent: "root", state: "running", startedAt: T0, nodeId: "root", parentId: null, depth: 0 },
		{ name: "centurion-0", agent: "centurion", state: "running", startedAt: T0, nodeId: "root.c0", parentId: "root", depth: 1 },
		{ name: "scout-0", agent: "scout", state: "running", startedAt: T0, nodeId: "root.s0", parentId: "root", depth: 1 },
		{ name: "scout-0", agent: "scout", state: "running", startedAt: T0 + 5, nodeId: "root.c0.s0", parentId: "root.c0", depth: 2 },
	];
	const names = nodesFromEntries(entries).map((n) => n.name);
	assert.deepEqual(names, ["root", "centurion-0", "scout-0", "centurion-0/scout-0"]);
});

// ---- per-type colors with pi's real themes -------------------------------------------------
const PI_THEME_DIR = new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/", import.meta.url);
const hexRgb = (h: string) => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });
/** xfce4-terminal's default (Tango) palette, as reported to pi over OSC 4. */
const XFCE_PALETTE = ["#000000", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
	"#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec"].map(hexRgb);
async function loadPiTheme(kind: "dark" | "system" | "system-truecolor"): Promise<any | undefined> {
	try {
		const th = await import(new URL("theme.js", PI_THEME_DIR).href);
		if (kind === "dark") return th.loadThemeFromPath(new URL("dark.json", PI_THEME_DIR).pathname, "truecolor");
		const sys = await import(new URL("system-theme.js", PI_THEME_DIR).href);
		const { colors } = sys.generateSystemThemeColors(kind === "system" ? {} : {
			foreground: hexRgb("#ffffff"), background: hexRgb("#000000"), palette: XFCE_PALETTE, saturation: 1,
		});
		const fs = await import("node:fs");
		const os = await import("node:os");
		const path = `${os.tmpdir()}/pi-legion-viz-system-theme-${process.pid}.json`;
		fs.writeFileSync(path, JSON.stringify({ name: "system-test", colors }));
		return th.loadThemeFromPath(path, "truecolor");
	} catch {
		return undefined;
	}
}

function laneColorsByRole(lines: string[], names: Record<string, string>): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of lines) {
		for (const [name, role] of Object.entries(names)) {
			const m = line.match(new RegExp(`(\\x1b\\[[0-9;]*m)(?:\\x1b\\[1m)?${name}`)) ?? line.match(new RegExp(`(\\x1b\\[38;[0-9;]*m)[^\\x1b]*${name}`));
			if (m) out.set(role, m[1]!);
		}
	}
	return out;
}

const TYPED = [{ ...ROOT, name: "root", role: "root" },
	node("centurion-0", { role: "centurion", startedAt: sec(0) }),
	node("scout-0", { role: "scout", startedAt: sec(1) }),
	node("worker-0", { role: "worker", startedAt: sec(2) }),
	node("reviewer-0", { role: "reviewer", startedAt: sec(3) }),
];
const TYPED_NAMES = { "centurion-0": "centurion", "scout-0": "scout", "worker-0": "worker", "reviewer-0": "reviewer" };

for (const kind of ["dark", "system", "system-truecolor"] as const) {
	test(`railway: every agent type gets a distinct ANSI color with pi's real ${kind} theme`, async (t) => {
		const theme = await loadPiTheme(kind);
		if (!theme) return t.skip("pi-coding-agent themes not installed");
		const out = renderRailway({ nodes: TYPED, now: sec(60), width: 140, rate: 100 })!;
		const lines = out.canvas.toLines(theme);
		const colors = laneColorsByRole(lines, TYPED_NAMES);
		assert.equal(colors.size, 4, JSON.stringify([...colors]));
		assert.equal(new Set(colors.values()).size, 4, `colors collide: ${JSON.stringify([...colors])}`);
		// The palette-index tier only has ~6 hues (minus error/dim), so check the five most common types there.
		const roles = kind !== "system"
			? ["centurion", "scout", "worker", "reviewer", "advisor", "planner", "x-custom"]
			: ["centurion", "scout", "worker", "reviewer", "planner"];
		const palette = resolveRolePalette(theme, roles);
		const ansi = [...palette.values()].map((token) => theme.getFgAnsi(token));
		assert.equal(new Set(ansi).size, palette.size, JSON.stringify([...palette]));
		assert.equal(palette.get("centurion"), "accent");
		if (kind === "dark") {
			assert.equal(palette.get("scout"), "syntaxNumber");
			assert.equal(palette.get("worker"), "syntaxVariable");
			assert.equal(palette.get("reviewer"), "syntaxFunction");
			assert.equal(palette.get("advisor"), "syntaxString");
			assert.equal(palette.get("planner"), "syntaxKeyword");
		} else if (kind === "system-truecolor") {
			// The user's xfce4-terminal: palette reported, truecolor output. accent and
			// syntaxNumber come out as byte-different but visually identical pinks.
			assert.notEqual(theme.getFgAnsi("accent"), theme.getFgAnsi("syntaxNumber"));
			assert.ok(swatchesClash(tokenSwatch(theme, "accent"), tokenSwatch(theme, "syntaxNumber")));
			assert.notEqual(palette.get("scout"), "syntaxNumber");
			const swatches = [...palette.values()].map((token) => tokenSwatch(theme, token));
			for (let i = 0; i < swatches.length; i++) for (let j = i + 1; j < swatches.length; j++) {
				assert.ok(!swatchesClash(swatches[i]!, swatches[j]!), `${[...palette.keys()][i]} vs ${[...palette.keys()][j]}`);
			}
		} else {
			// system theme without a reported palette: accent and syntaxNumber are both ANSI 5.
			assert.equal(theme.getFgAnsi("accent"), theme.getFgAnsi("syntaxNumber"));
			assert.notEqual(palette.get("scout"), "syntaxNumber");
		}
		// The /legion view uses the same resolution.
		const sampler = new RateSampler();
		const view = renderLegionView({ nodes: TYPED, sampler, now: sec(60), rate: 0 }, initialViewState(), 160, 50).canvas.toLines(theme);
		const viewColors = laneColorsByRole(view, TYPED_NAMES);
		assert.equal(new Set(viewColors.values()).size, viewColors.size);
		// Strip and /legion agree on each type's color (root never steals one).
		const stripPalette = resolveRolePalette(theme, out.canvas.roles());
		const viewPalette = resolveRolePalette(theme, renderLegionView({ nodes: TYPED, sampler, now: sec(60), rate: 0 }, initialViewState(), 160, 50).canvas.roles());
		for (const role of ["centurion", "scout", "worker", "reviewer"]) assert.equal(viewPalette.get(role), stripPalette.get(role), role);
	});
}

test("status board: railway repaints every second while a subagent is live and stops when idle", () => {
	const intervals = new Map<number, () => void>();
	let nextId = 1;
	let renders = 0;
	let factory: WidgetFactory | undefined;
	const board = createStatusBoard({
		strip: "railway",
		setInterval: (fn, ms) => {
			assert.equal(ms, 1000);
			intervals.set(nextId, fn);
			return nextId++;
		},
		clearInterval: (id) => intervals.delete(id as number),
	});
	board.bind({ hasUI: true, ui: { theme: plainTheme, setStatus() {}, setWidget(_k, content) { factory = typeof content === "function" ? content : undefined; } } });
	const now = Date.now();
	const live: StatusEntry[] = [
		{ name: "root", agent: "root", state: "running", startedAt: now, nodeId: "root", parentId: null, depth: 0 },
		{ name: "scout-0", agent: "scout", state: "running", startedAt: now, nodeId: "root.s", parentId: "root", depth: 1 },
	];
	board.paint(live, now);
	factory!({ requestRender() { renders++; } }, plainTheme).render(100);
	board.paint(live, now + 500);
	assert.equal(intervals.size, 1);
	const before = renders;
	[...intervals.values()][0]!();
	assert.equal(renders, before + 1);
	board.paint(live.map((e) => e.nodeId === "root.s" ? { ...e, state: "settled", finishedAt: now + 900 } : e), now + 1000);
	assert.equal(intervals.size, 0, "ticker must stop when no subagent is live");
	board.clear();
});

test("layout: tall terminals cap galaxy/chart heights; few events hand log space to the galaxy", () => {
	for (const [w, h] of [[110, 120], [120, 100], [90, 80], [60, 120], [46, 60], [100, 40], [139, 69], [160, 50], [220, 105]] as const) {
		const l = computeLayout(w, h);
		assert.ok(l.chart.h <= 24, `${w}x${h} chart ${l.chart.h}`);
		if (l.kind === "portrait") {
			assert.ok(l.chart.h >= 10 || h < 40, `${w}x${h} chart ${l.chart.h}`);
			assert.ok(l.galaxy.h <= Math.round(w * 0.65), `${w}x${h} galaxy ${l.galaxy.h}`);
			assert.equal(l.galaxy.w, w);
			assert.equal(l.chart.y, l.galaxy.y + l.galaxy.h);
			assert.equal(l.log.y, l.chart.y + l.chart.h);
		}
		if (l.kind === "stacked") assert.ok(l.galaxy.h <= 24);
		for (const r of [l.galaxy, l.chart, l.log]) assert.ok(r.y + r.h <= h - 1 && r.x + r.w <= w);
	}
	const many = computeLayout(110, 120, { logEvents: 200 });
	const few = computeLayout(110, 120, { logEvents: 4 });
	assert.ok(few.galaxy.h > many.galaxy.h, `${few.galaxy.h} > ${many.galaxy.h}`);
	assert.ok(few.log.h >= 8);
	assert.equal(few.chart.h, many.chart.h);
});

test("legion view: tall sizes render full width/height without clipping", () => {
	const { nodes, sampler, now } = scenario();
	const data = { nodes, sampler, now, rate: sampler.totalRate(now) };
	for (const [w, h] of [[110, 120], [120, 100], [90, 80], [60, 120]] as const) {
		const { canvas, layout } = renderLegionView(data, initialViewState(), w, h);
		assert.equal(layout, "portrait");
		const lines = canvas.toLines(ansiTheme);
		assert.equal(lines.length, h);
		for (const line of lines) assert.equal(visibleWidth(line), w);
	}
});

test("railway: ended scouts vanish — one row, only the survivor's label, no orphan glyphs on the header", () => {
	const nodes = [ROOT,
		node("scout-0", { startedAt: sec(0), status: "settled", endedAt: sec(60) }),
		node("scout-1", { startedAt: sec(30), status: "settled", endedAt: sec(120) }),
		node("scout-2", { startedAt: sec(50), status: "failed", endedAt: sec(150) }),
		node("scout-3", { startedAt: sec(100) }),
	];
	for (let t = 160; t <= 220; t += 1) {
		const out = renderRailway({ nodes, now: sec(t), width: 120, rate: 10 })!;
		const lines = out.canvas.toLines(plainTheme);
		assert.equal(lines.length, 2, "header + one lane");
		assert.deepEqual(out.nodeIdsByRow, [undefined, "scout-3"]);
		assert.match(lines[0]!, /^[─┬\s\-−0-9a-z·./]+$/, `header has only rule/text/spawn tick: ${lines[0]}`);
		// Exactly one spawn tick: scout-3's (root-spawned, live), at its lane start, owned by it.
		const ticks = Array.from(lines[0]!).flatMap((ch, x) => ch === "┬" ? [x] : []);
		assert.equal(ticks.length, 1);
		assert.equal(out.hit[0]![ticks[0]!], "scout-3");
		assert.equal(Array.from(lines[1]!)[ticks[0]!], "╰");
		assert.doesNotMatch(lines.join("\n"), /scout-[012]/);
		assert.equal((lines[1]!.match(/scout-3/g) ?? []).length, 1);
		assert.doesNotMatch(lines[1]!, /[┴┬✗]/);
	}
});

test("railway: all lanes share one time axis — every lane head is at the same x and scrolls in sync", () => {
	const nodes = [ROOT,
		node("worker-0", { startedAt: sec(0) }),
		node("scout-1", { startedAt: sec(40), parentId: "worker-0", depth: 2 }),
		node("scout-2", { startedAt: sec(90) }),
		node("scout-3", { startedAt: sec(20), status: "settled", endedAt: sec(100) }),
	];
	const startX = (line: string, from: string): number => Array.from(line).findIndex((ch) => from.includes(ch));
	const frame = (t: number) => {
		const lines = renderRailway({ nodes, now: sec(t), width: 120, rate: 0 })!.canvas.toLines(plainTheme).slice(1).map((l) => Array.from(l));
		return lines.map((l) => ({ head: l.lastIndexOf("━"), start: startX(l.join(""), "╺╰╭┄├") }));
	};
	const a = frame(150);
	assert.equal(a.length, 3, "ended scout-3 is compacted away");
	assert.ok(a.every((l) => l.head === a[0]!.head), `heads must share now-column: ${JSON.stringify(a)}`);
	// Advance now: every on-screen start marker must move left by the *exact* same integer.
	const b = frame(195);
	const shifts = a.map((l, i) => l.start - b[i]!.start);
	assert.ok(shifts.every((s) => s === shifts[0]), `lockstep shifts: ${JSON.stringify(shifts)}`);
	assert.ok(shifts[0]! > 0, `window must advance leftward: ${JSON.stringify({ a, b, shifts })}`);
	assert.ok(b.every((l) => l.head === a[0]!.head), "heads stay glued to the shared now-column");
});

test("railway: axisColumn shifts every timestamp by the same delta (no per-lane floor drift)", () => {
	const AW = 80;
	const windowMs = 360_000;
	const t0 = sec(100);
	const t1 = sec(113); // not a multiple of dt — the old floor((t-origin)/dt) desynced here
	const starts = [sec(0), sec(40), sec(90), sec(100)];
	const shifts = starts.map((t) => axisColumn(t, t0, windowMs, AW) - axisColumn(t, t1, windowMs, AW));
	assert.ok(shifts.every((s) => s === shifts[0]), JSON.stringify(shifts));
	assert.equal(axisColumn(t0, t0, windowMs, AW), AW - 1, "now lands on last drawable column");
});

test("railway: tick-by-tick lockstep — no lane jumps alone while others stay put", () => {
	const nodes = [ROOT,
		node("worker-0", { startedAt: sec(0) }),
		node("scout-1", { startedAt: sec(40), parentId: "worker-0", depth: 2 }),
		node("scout-2", { startedAt: sec(90) }),
	];
	const startsAt = (t: number) =>
		renderRailway({ nodes, now: sec(t), width: 120, rate: 0 })!.canvas.toLines(plainTheme).slice(1)
			.map((line) => Array.from(line).findIndex((ch) => "╺╰╭┄├".includes(ch)));
	let prev = startsAt(100);
	for (let t = 101; t <= 160; t += 1) {
		const cur = startsAt(t);
		const shifts = prev.map((p, i) => p - cur[i]!);
		assert.ok(shifts.every((s) => s === shifts[0]), `t=${t} shifts=${JSON.stringify(shifts)}`);
		prev = cur;
	}
});

test("railway hit map: every drawn cell maps to the agent whose glyph it is (fork from parent lane, compaction)", () => {
	const nodes = [ROOT,
		node("worker-0", { startedAt: sec(0) }),
		node("scout-9", { startedAt: sec(10), status: "settled", endedAt: sec(60) }), // ended -> compacted away
		node("scout-1", { startedAt: sec(120), parentId: "worker-0", depth: 2 }), // forks off worker-0's lane
		node("scout-2", { startedAt: sec(200) }),
	];
	const out = renderRailway({ nodes, now: sec(300), width: 120, rate: 0 })!;
	const lines = out.canvas.toLines(plainTheme).map((l) => Array.from(l));
	assert.equal(out.hit.length, lines.length);
	assert.deepEqual(out.nodeIdsByRow, [undefined, "worker-0", "scout-1", "scout-2"]);
	const nameX = lines[1]!.indexOf("▶");
	// Lane start column per agent (where its ╰/├/╭/╺ cap is drawn).
	const startX = new Map<string, number>();
	for (let y = 1; y < lines.length; y++) startX.set(out.nodeIdsByRow[y]!, lines[y]!.findIndex((ch) => "╰├╭╺┄".includes(ch)));
	// Header: only ┬ spawn ticks of root-spawned live lanes are clickable (owned by that child).
	lines[0]!.forEach((ch, x) => {
		if (ch === "┬") assert.ok(["worker-0", "scout-2"].includes(out.hit[0]![x]!) && startX.get(out.hit[0]![x]!) === x, `tick ${x}`);
		else assert.equal(out.hit[0]![x], undefined, `header ${x}`);
	});
	assert.equal(lines[0]!.filter((ch) => ch === "┬").length, 2);
	let forkCells = 0;
	for (let y = 1; y < lines.length; y++) {
		for (let x = 0; x < lines[y]!.length; x++) {
			const ch = lines[y]![x]!;
			const id = out.hit[y]![x];
			if (x >= nameX) { assert.equal(id, out.nodeIdsByRow[y], `name col ${x},${y}`); continue; }
			if (ch === "·" || ch === " ") assert.equal(id, undefined, `background ${x},${y}`);
			else if (ch === "━" || ch === "╺" || ch === "┿") assert.equal(id, out.nodeIdsByRow[y], `lane ${x},${y} ${ch}`);
			else if ("╰╭├│┳┻".includes(ch)) {
				assert.ok(id !== undefined && startX.get(id) === x, `connector ${x},${y} ${ch} -> ${id}`);
				if (id === "scout-1") forkCells++;
			}
			else assert.fail(`unexpected glyph ${ch} at ${x},${y}`);
		}
	}
	assert.ok(forkCells >= 2, "fork connector (┳ on parent lane + ╰ on child) is owned by the child");
	assert.ok(!out.hit.flat().includes("scout-9"), "ended, compacted agent owns no cells");
});

test("status board: railway click opens the agent of the exact cell; name column opens the row; empty cells are no-ops", () => {
	let factory: WidgetFactory | undefined;
	const opened: string[] = [];
	const ctx: StatusUi = { hasUI: true, ui: { theme: plainTheme, setStatus() {}, setWidget(_k, c) { factory = typeof c === "function" ? c : undefined; } } };
	const board = createStatusBoard({ strip: "railway", onNodeClick: (id) => opened.push(id) });
	board.bind(ctx);
	const now = Date.now();
	const entries: StatusEntry[] = [
		{ name: "centurion-0", agent: "centurion", state: "running", startedAt: now - 300_000, nodeId: "root", parentId: null, depth: 0 },
		{ name: "worker-0", agent: "worker", state: "running", startedAt: now - 200_000, nodeId: "root.w", parentId: "root", depth: 1 },
		{ name: "scout-1", agent: "scout", state: "running", startedAt: now - 100_000, nodeId: "root.w.s", parentId: "root.w", depth: 2 },
	];
	board.paint(entries, now);
	const comp = factory!({ requestRender() {} }, plainTheme);
	const lines = comp.render(120).map((l) => Array.from(stripTerminalSequences(l)));
	const click = (x: number, y: number) => {
		const ev = (type: string) => ({ type, button: "left", x, y, screenX: x, screenY: y, width: 120, height: lines.length }) as never;
		const pressed = comp.handleMouse!(ev("press"));
		return [pressed, comp.handleMouse!(ev("click"))];
	};
	// Fork glyph on worker-0's lane opens scout-1; a plain cell on that same row opens worker-0.
	const forkX = lines[1]!.findIndex((ch) => ch === "┳");
	assert.ok(forkX > 0);
	click(forkX, 1);
	click(forkX + 2, 1);
	click(lines[2]!.lastIndexOf("━"), 2);
	click(lines[2]!.indexOf("▶") + 4, 2);
	assert.deepEqual(opened, ["root.w.s", "root.w", "root.w.s", "root.w.s"]);
	// Dotted background and header do nothing.
	assert.deepEqual(click(2, 2), [undefined, undefined]);
	assert.deepEqual(click(10, 0), [undefined, undefined]);
	assert.equal(opened.length, 4);
	board.clear();
});

const many = (n: number, opts: (i: number) => Partial<VizNode> = () => ({})) =>
	Array.from({ length: n }, (_, i) => node(`scout-${i}`, { role: "scout", startedAt: sec(i), ...opts(i) }));

test("railway scroll: window math, indicator text and ▲/▼ hints", () => {
	const nodes = [ROOT, ...many(12)];
	const live = liveAt(nodes, sec(100));
	assert.equal(resolveScroll(live, 4, undefined), 0);
	assert.equal(resolveScroll(live, 4, { offset: 4 }), 4);
	assert.equal(resolveScroll(live, 4, { offset: 99 }), 8);
	assert.equal(resolveScroll(live, 4, { offset: -3 }), 0);
	assert.equal(scrollIndicator(4, 4, 12), "5-8/12");
	const mid = renderRailway({ nodes, now: sec(100), width: 120, rate: 0, scroll: { offset: 4 } })!;
	const plain = mid.canvas.toPlain();
	assert.match(plain[0]!, /legion 12 live · 5-8\/12 ▲▼ · /);
	assert.deepEqual(mid.nodeIdsByRow, [undefined, "scout-4", "scout-5", "scout-6", "scout-7"]);
	assert.match(plain[1]!, / ▲$/);
	assert.match(plain[4]!, / ▼$/);
	const end = renderRailway({ nodes, now: sec(100), width: 120, rate: 0, scroll: { offset: 8 } })!;
	assert.match(end.canvas.toPlain()[0]!, / 9-12\/12 ▲  · /);
	assert.doesNotMatch(end.canvas.toPlain()[4]!, /▼/);
	for (const r of [mid, end]) for (const line of r.canvas.toLines(ansiTheme)) assert.equal(visibleWidth(line), 120);
});

test("railway scroll: clamps as agents end/start, new agents don't yank, all-fit resets to 0, hidden when none live", () => {
	const base = many(10);
	const at = (nodes: VizNode[], t: number, scroll: { offset: number; topId?: string }) => renderRailway({ nodes: [ROOT, ...nodes], now: sec(t), width: 120, rate: 0, scroll });
	// Viewing scout-4..7; two agents above end -> anchor keeps scout-4 on top.
	const ended = base.map((n, i) => i < 2 ? { ...n, status: "settled" as const, endedAt: sec(50) } : n);
	const a = at(ended, 60, { offset: 4, topId: "scout-4" })!;
	assert.deepEqual(a.nodeIdsByRow.slice(1), ["scout-4", "scout-5", "scout-6", "scout-7"]);
	assert.equal(a.offset, 2);
	// New agents start (appended at the bottom) -> same view.
	const grown = [...base, ...Array.from({ length: 3 }, (_, i) => node(`late-${i}`, { startedAt: sec(70 + i) }))];
	assert.deepEqual(at(grown, 80, { offset: 4, topId: "scout-4" })!.nodeIdsByRow.slice(1), ["scout-4", "scout-5", "scout-6", "scout-7"]);
	// Anchor itself ends and the list shrinks -> offset clamps to the last full window.
	const shrunk = base.map((n, i) => i >= 3 ? { ...n, status: "settled" as const, endedAt: sec(50) } : n).concat([node("x", { startedAt: sec(55) }), node("y", { startedAt: sec(56) })]);
	const c = at(shrunk, 60, { offset: 4, topId: "scout-4" })!;
	assert.equal(c.total, 5);
	assert.equal(c.offset, 1);
	// Everything fits -> offset 0, no indicator.
	const fit = at(base.slice(0, 3), 60, { offset: 5, topId: "scout-2" })!;
	assert.equal(fit.offset, 0);
	assert.doesNotMatch(fit.canvas.toPlain()[0]!, /\d+-\d+\/\d+|[▲▼]/);
	// No live agents -> hidden regardless of scroll.
	assert.equal(at(base.map((n) => ({ ...n, status: "settled" as const, endedAt: sec(20) })), 60, { offset: 3 }), undefined);
});

test("railway scroll: hit map follows the scrolled window", () => {
	const nodes = [ROOT, ...many(12)];
	const out = renderRailway({ nodes, now: sec(100), width: 120, rate: 0, scroll: { offset: 6 } })!;
	const lines = out.canvas.toLines(plainTheme).map((l) => Array.from(l));
	assert.deepEqual(out.nodeIdsByRow.slice(1), ["scout-6", "scout-7", "scout-8", "scout-9"]);
	for (let y = 1; y < lines.length; y++) {
		const nameX = lines[y]!.indexOf("▶");
		lines[y]!.forEach((ch, x) => {
			const id = out.hit[y]![x];
			if (x >= nameX) assert.equal(id, out.nodeIdsByRow[y]);
			else if (ch === "·" || ch === " ") assert.equal(id, undefined);
			else assert.equal(id, out.nodeIdsByRow[y], `${x},${y} ${ch}`);
		});
	}
	assert.ok(!out.hit.flat().some((id) => id === "scout-0" || id === "scout-11"));
});

test("status board: wheel over the railway scrolls lanes (65 down / 64 up), clicks follow, no-op when all fit", () => {
	let factory: WidgetFactory | undefined;
	const opened: string[] = [];
	let renders = 0;
	const ctx: StatusUi = { hasUI: true, ui: { theme: plainTheme, setStatus() {}, setWidget(_k, c) { factory = typeof c === "function" ? c : undefined; } } };
	const board = createStatusBoard({ strip: "railway", onNodeClick: (id) => opened.push(id) });
	board.bind(ctx);
	const now = Date.now();
	const entry = (i: number): StatusEntry => ({ name: `scout-${i}`, agent: "scout", state: "running", startedAt: now - 100_000 + i * 1000, nodeId: `root.s${i}`, parentId: "root", depth: 1 });
	const entries: StatusEntry[] = [
		{ name: "centurion-0", agent: "centurion", state: "running", startedAt: now - 300_000, nodeId: "root", parentId: null, depth: 0 },
		...Array.from({ length: 8 }, (_, i) => entry(i)),
	];
	board.paint(entries, now);
	const comp = factory!({ requestRender() { renders++; } }, plainTheme);
	const ev = (type: string, y: number, extra: object = {}) => ({ type, button: type === "wheel" ? "none" : "left", x: 115, y, screenX: 115, screenY: y, width: 120, height: 5, ...extra }) as never;
	const names = () => comp.render(120).slice(1).map((l) => /▶ (\S+)/.exec(stripTerminalSequences(l))?.[1]);
	assert.deepEqual(names(), ["scout-0", "scout-1", "scout-2", "scout-3"]);
	assert.deepEqual(comp.handleMouse!(ev("wheel", 2, { wheelDelta: 1 })), { handled: true });
	assert.deepEqual(names(), ["scout-1", "scout-2", "scout-3", "scout-4"]);
	comp.handleMouse!(ev("wheel", 2, { wheelDelta: 10 }));
	assert.deepEqual(names(), ["scout-4", "scout-5", "scout-6", "scout-7"], "clamped at the end");
	assert.match(stripTerminalSequences(comp.render(120)[0]!), /5-8\/8 ▲ /);
	// Click on the name column in the scrolled window opens that lane's agent.
	comp.handleMouse!(ev("press", 1)); comp.handleMouse!(ev("click", 1));
	assert.deepEqual(opened, ["root.s4"]);
	comp.handleMouse!(ev("wheel", 2, { wheelDelta: -1 }));
	assert.deepEqual(names(), ["scout-3", "scout-4", "scout-5", "scout-6"]);
	assert.ok(renders >= 3);
	// When all agents fit, wheel is not consumed (pi scrolls the chat instead).
	board.paint(entries.slice(0, 3), now);
	comp.render(120);
	assert.equal(comp.handleMouse!(ev("wheel", 1, { wheelDelta: 1 })), undefined);
	board.clear();
});

test("railway: root-spawned lanes get a ┬ spawn connector from the header; siblings at the same x share one vertical", () => {
	const nodes = [ROOT,
		node("worker-0", { startedAt: sec(100) }),
		node("scout-1", { startedAt: sec(200) }),
		node("scout-2", { startedAt: sec(200) }),
		node("scout-3", { startedAt: sec(200) }),
		node("gone", { startedAt: sec(150), status: "settled", endedAt: sec(250) }),
	];
	const out = renderRailway({ nodes, now: sec(300), width: 120, rate: 0 })!;
	const lines = out.canvas.toLines(plainTheme).map((l) => Array.from(l));
	const ticks = lines[0]!.flatMap((ch, x) => ch === "┬" ? [x] : []);
	assert.equal(ticks.length, 2, "worker-0 + one shared tick for the three siblings; none for the ended agent");
	const [wx, sx] = ticks as [number, number];
	assert.equal(lines[1]![wx], "╰");
	assert.deepEqual([lines[1]![sx], lines[2]![sx], lines[3]![sx], lines[4]![sx]], ["┿", "├", "├", "╰"], "crosses worker-0's lane");
	assert.equal(out.hit[1]![sx], "worker-0", "a crossing stays with the lane it sits on");
	assert.equal(out.hit[0]![sx], "scout-1");
	assert.equal(out.hit[4]![sx], "scout-3");
	assert.equal(out.hit[2]![sx], "scout-1");
	for (const line of out.canvas.toLines(ansiTheme)) assert.equal(visibleWidth(line), 120);
});

test("railway: a finished sibling drops off at once while others stay live; no ┴ merge-back on the header", () => {
	const nodes = [
		ROOT,
		node("search-0", { role: "scout", startedAt: sec(0) }),
		node("search-1", { role: "scout", startedAt: sec(0), status: "settled", endedAt: sec(210) }),
		node("search-2", { role: "scout", startedAt: sec(0) }),
	];
	const out = renderRailway({ nodes, now: sec(300), width: 110, rate: 0 })!;
	assert.deepEqual(out.shown.map((n) => n.id), ["search-0", "search-2"]);
	const text = out.canvas.toLines(plainTheme).join("\n");
	assert.ok(!text.includes("search-1"), "finished lane and label are gone");
	for (const ch of ["┴", "┼", "┿"]) assert.ok(!text.includes(ch), `no merge-back/crossing glyph ${ch} left by the ended lane`);
	assert.match(text, /2 live/);
});

test("status board entries: settled/awaiting-success children are not live lanes", () => {
	const entries: StatusEntry[] = [
		{ name: "root", agent: "root", state: "running", startedAt: sec(0), nodeId: "root", parentId: null, depth: 0 },
		{ name: "search-0", agent: "scout", state: "working", startedAt: sec(0), nodeId: "root.0", parentId: "root", depth: 1 },
		{ name: "search-1", agent: "scout", state: "settled", startedAt: sec(0), finishedAt: sec(30), nodeId: "root.1", parentId: "root", depth: 1 },
		{ name: "search-2", agent: "scout", state: "failed", startedAt: sec(0), finishedAt: sec(30), nodeId: "root.2", parentId: "root", depth: 1 },
	];
	const out = renderRailway({ nodes: nodesFromEntries(entries), now: sec(60), width: 120, rate: 0 })!;
	assert.deepEqual(out.shown.map((n) => n.name), ["search-0"]);
});

test("railway: root spawn connector hangs DOWN from the header (┬ above │ above ╰), never above it", () => {
	const nodes = [ROOT, node("a-0", { role: "scout", startedAt: sec(10) }), node("b-0", { role: "worker", startedAt: sec(10) })];
	const out = renderRailway({ nodes, now: sec(60), width: 120, rate: 0 })!;
	const lines = out.canvas.toLines(plainTheme).map((l) => Array.from(l));
	const x = lines[0]!.indexOf("┬");
	assert.ok(x > 0, "spawn tick on the header rule");
	assert.equal(lines[1]![x], "├", "first sibling's ╰ becomes ├ as the shared vertical continues down");
	assert.equal(lines[2]![x], "╰", "vertical ends turning right into the lowest lane");
	for (const line of lines) for (const ch of ["┴", "╯", "╭", "┘"]) assert.ok(!line.includes(ch), `no upward glyph ${ch}`);
});
