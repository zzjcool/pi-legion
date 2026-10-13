import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { displayStatus, nodesFromEntries, type VizNode } from "../../src/tui/viz/model.ts";
import { FALLBACK_TOKENS, nodeToken, resolveRolePalette, roleColor, roleToken, swatchesClash, tokenSwatch } from "../../src/tui/viz/palette.ts";
import { RateSampler, RATE_WINDOW_MS } from "../../src/tui/viz/rate.ts";
import { assignLanes, liveAt, maxLanesFor, renderRailway } from "../../src/tui/viz/railway.ts";
import { computeLayout, selectLayout } from "../../src/tui/viz/layout.ts";
import { buildLog, computeStats } from "../../src/tui/viz/panels.ts";
import { createLegionViewFactory, handleViewKey, initialViewState, renderLegionView } from "../../src/tui/viz/view.ts";
import { ellipsize } from "../../src/tui/viz/canvas.ts";
import { createStatusBoard, type StatusEntry, type StatusUi, type WidgetFactory } from "../../src/tui/status.ts";

const T0 = 1_700_000_000_000;
const sec = (s: number): number => T0 + s * 1000;

function node(id: string, opts: Partial<VizNode> = {}): VizNode {
	return { id, name: id, role: id.replace(/-\d+$/, ""), parentId: "root", depth: 1, status: "running", startedAt: T0, tokens: 0, ...opts };
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

test("railway: lane priority is oldest then shallowest, overflow folds into +N", () => {
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
	assert.match(narrow.canvas.toPlain()[3]!, /\+4$/);
	const wide = renderRailway({ nodes, now: sec(10), width: 120, rate: 0 })!;
	assert.equal(wide.canvas.height, 5);
	assert.match(wide.canvas.toPlain()[4]!, /\+3\s*$/);
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

test("rate: 60s window average, cumulative counters never regress, late spawns start at zero", () => {
	const sampler = new RateSampler();
	for (let t = 0; t <= 300; t += 5) {
		sampler.record(sec(t), [ROOT,
			node("a", { tokens: 100 * t }),
			...(t >= 100 ? [node("b", { startedAt: sec(100), tokens: 50 * (t - 100) })] : []),
		]);
	}
	assert.ok(Math.abs(sampler.nodeRate("a", sec(300)) - 100) < 1e-6);
	assert.ok(Math.abs(sampler.totalRate(sec(300)) - 150) < 1e-6);
	assert.equal(sampler.valueAt("b", sec(100)), 0);
	assert.equal(RATE_WINDOW_MS, 60_000);
	sampler.record(sec(305), [node("a", { tokens: 10 })]);
	assert.equal(sampler.valueAt("a", sec(305)), 30_000);
	const buckets = sampler.buckets(sec(200), sec(300), 10);
	for (const v of buckets.total) assert.ok(Math.abs(v - 150) < 1e-6);
	assert.deepEqual([...buckets.byRole.keys()].sort(), ["a", "b"]);
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
		{ name: "worker-1", agent: "worker", state: "running", startedAt: now - 30_000, nodeId: "root.worker-1", parentId: "root", depth: 1, tokensTotal: 100 },
	];
	board.paint(entries, now - 1000);
	board.paint(entries.map((e) => e.nodeId === "root.worker-1" ? { ...e, tokensTotal: 700 } : e), now);
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
	// Session-file token counts arrive in bursts: +6000 tokens in one refresh.
	for (let t = 0; t <= 240; t += 2) sampler.record(sec(t), [ROOT, node("a", { tokens: t >= 120 ? 6000 : 0 })]);
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
