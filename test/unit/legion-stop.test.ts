import { test } from "node:test";
import assert from "node:assert/strict";
import {
	IDLE_STOP_HINT,
	IDLE_STOP_HINT_SHORT,
	resolveStopTarget,
	runLegionStop,
	stopCompletions,
	type StopJob,
	type StopNode,
} from "../../src/extension/legion-stop.ts";
import { renderRailway } from "../../src/tui/viz/railway.ts";
import { handleViewKey, initialViewState, renderLegionView } from "../../src/tui/viz/view.ts";
import { RateSampler } from "../../src/tui/viz/rate.ts";
import type { VizNode } from "../../src/tui/viz/model.ts";

const N = (id: string, name: string, parentId: string | null, depth: number, status = "running"): StopNode => ({ id, name, parentId, depth, status });
const NODES: StopNode[] = [
	N("root", "centurion-0", null, 0),
	N("root.a", "scout-0", "root", 1),
	N("root.b", "scout-1", "root", 1),
	N("root.c", "centurion-1", "root", 1),
	N("root.c.d", "scout-0", "root.c", 2),
	N("root.e", "scout-9", "root", 1, "settled"),
];
const JOBS: StopJob[] = [
	{ name: "scout-0", nodeId: "root.a", state: "running" },
	{ name: "scout-1", nodeId: "root.b", state: "running" },
	{ name: "centurion-1", state: "running" },
	{ name: "scout-9", nodeId: "root.e", state: "retired" },
];

test("legion stop: parsing — no arg and `all` stop all; names, ids and parent/name resolve", () => {
	assert.deepEqual(resolveStopTarget("", JOBS, NODES), { kind: "all" });
	assert.deepEqual(resolveStopTarget("  all ", JOBS, NODES), { kind: "all" });
	assert.deepEqual(resolveStopTarget("scout-1", JOBS, NODES), { kind: "job", name: "scout-1" });
	assert.deepEqual(resolveStopTarget("root.b", JOBS, NODES), { kind: "job", name: "scout-1" });
	// centurion-1's job has no nodeId: matched by name at depth 1.
	assert.deepEqual(resolveStopTarget("root.c", JOBS, NODES), { kind: "job", name: "centurion-1" });
	// Duplicate name: the direct child wins; the nested one needs parent/name.
	assert.deepEqual(resolveStopTarget("scout-0", JOBS, NODES), { kind: "job", name: "scout-0" });
	assert.deepEqual(resolveStopTarget("centurion-1/scout-0", JOBS, NODES), { kind: "nested", label: "centurion-1/scout-0", owner: "centurion-1" });
	assert.deepEqual(resolveStopTarget("nope", JOBS, NODES), { kind: "notFound", query: "nope" });
	assert.deepEqual(resolveStopTarget("scout-9", JOBS, NODES), { kind: "notFound", query: "scout-9" }, "retired children are not targets");
});

test("legion stop: completion lists all, live children and nested parent/name", () => {
	const all = stopCompletions("", JOBS, NODES).map((c) => c.value);
	assert.deepEqual(all, ["all", "scout-0", "scout-1", "centurion-1", "centurion-1/scout-0"]);
	assert.deepEqual(stopCompletions("cen", JOBS, NODES).map((c) => c.value), ["centurion-1", "centurion-1/scout-0"]);
	assert.match(stopCompletions("a", JOBS, NODES)[0]!.label, /3 live/);
});

function deps(jobs = JOBS) {
	const calls: Array<{ name?: string; all?: boolean }> = [];
	const notes: Array<[string, string]> = [];
	return {
		calls,
		notes,
		deps: {
			jobs: () => jobs,
			nodes: () => NODES,
			stop: async (params: { name?: string; all?: boolean }) => {
				calls.push(params);
				return { ok: true, text: params.all ? "Stopped 3 children: scout-0, scout-1, centurion-1." : `Stopped 1 child: ${params.name}.` };
			},
			notify: (message: string, type: string) => notes.push([message, type]),
		},
	};
}

test("legion stop: runLegionStop — one, all, not found, nested, nothing running", async () => {
	let d = deps();
	assert.equal(await runLegionStop("scout-1", d.deps), "Stopped 1 child: scout-1.");
	assert.deepEqual(d.calls, [{ name: "scout-1" }]);
	d = deps();
	await runLegionStop("", d.deps);
	assert.deepEqual(d.calls, [{ all: true }]);
	d = deps();
	assert.match(await runLegionStop("ghost", d.deps), /No live subagent named "ghost"\. Live: scout-0, scout-1, centurion-1/);
	assert.equal(d.notes[0]![1], "warning");
	assert.equal(d.calls.length, 0);
	d = deps();
	assert.match(await runLegionStop("centurion-1/scout-0", d.deps), /owned by centurion-1; stop centurion-1/);
	assert.equal(d.calls.length, 0);
	d = deps(JOBS.map((j) => ({ ...j, state: "retired" })));
	assert.equal(await runLegionStop("all", d.deps), "Nothing running: no live subagents.");
	assert.equal(d.calls.length, 0);
});

const T0 = 1_700_000_000_000;
const vnode = (id: string, opts: Partial<VizNode> = {}): VizNode => ({ id, name: id, role: "scout", parentId: "root", depth: 1, status: "running", startedAt: T0, tokens: 0, tokensOut: 0, generationMs: 0, ...opts });
const ROOT = vnode("root", { name: "centurion-0", role: "centurion", parentId: null, depth: 0 });

test("railway: stop hint shows dim on the header, shortens on narrow widths, truncates under squeeze", () => {
	const nodes = [ROOT, vnode("scout-1")];
	const wide = renderRailway({ nodes, now: T0 + 60_000, width: 120, rate: 0, hint: IDLE_STOP_HINT, hintShort: IDLE_STOP_HINT_SHORT })!;
	assert.match(wide.canvas.toPlain()[0]!, /\/legion stop \[name\|all\]/);
	const narrow = renderRailway({ nodes, now: T0 + 60_000, width: 50, rate: 0, hint: IDLE_STOP_HINT, hintShort: IDLE_STOP_HINT_SHORT })!;
	assert.match(narrow.canvas.toPlain()[0]!, / \/legion stop /);
	assert.doesNotMatch(narrow.canvas.toPlain()[0]!, /name\|all/);
	// Width 40 used to drop the hint entirely; now reserve/truncate so short form survives.
	const tiny = renderRailway({ nodes, now: T0 + 60_000, width: 40, rate: 0, hint: IDLE_STOP_HINT, hintShort: IDLE_STOP_HINT_SHORT })!;
	assert.match(tiny.canvas.toPlain()[0]!, /\/legion stop/);
	for (const r of [wide, narrow, tiny]) for (const line of r.canvas.toPlain()) assert.equal(Array.from(line).length, r.canvas.width);
	const none = renderRailway({ nodes, now: T0 + 60_000, width: 120, rate: 0 })!;
	assert.doesNotMatch(none.canvas.toPlain()[0]!, /legion stop/);
});

test("legion view: x on a live selected agent asks to stop; ended or no selection is a no-op", () => {
	const nodes = [ROOT, vnode("scout-1"), vnode("scout-2", { status: "settled", endedAt: T0 + 1000 })];
	const state = initialViewState();
	assert.equal(handleViewKey("x", state, nodes), "none");
	state.selectedId = "scout-1";
	assert.equal(handleViewKey("x", state, nodes), "render", "x opens the in-view y/N prompt");
	assert.equal(state.pendingStopId, "scout-1");
	const prompt = renderLegionView({ nodes, sampler: new RateSampler(), now: T0 + 5000, rate: 0 }, state, 120, 40).canvas.toPlain();
	assert.match(prompt[prompt.length - 1]!, /Stop scout-1\? .*y stop/);
	assert.equal(handleViewKey("y", state, nodes), "stop");
	delete state.pendingStopId;
	handleViewKey("x", state, nodes);
	assert.equal(handleViewKey("n", state, nodes), "render", "any other key cancels");
	assert.equal(state.pendingStopId, undefined);
	state.selectedId = "scout-2";
	assert.equal(handleViewKey("x", state, nodes), "none");
});

test("status board: stop hint is persistent while live children exist (no idle gate)", async () => {
	const { createStatusBoard } = await import("../../src/tui/status.ts");
	let factory: ((tui: { requestRender(): void }, theme: unknown) => { render(w: number): string[] }) | undefined;
	const plain = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const board = createStatusBoard({ strip: "railway" });
	board.bind({ hasUI: true, ui: { theme: plain, setStatus() {}, setWidget(_k: string, c: unknown) { factory = typeof c === "function" ? c as never : undefined; } } } as never);
	const now = Date.now();
	board.paint([
		{ name: "centurion-0", agent: "centurion", state: "running", startedAt: now - 60_000, nodeId: "root", parentId: null, depth: 0 },
		{ name: "scout-1", agent: "scout", state: "running", startedAt: now - 30_000, nodeId: "root.s", parentId: "root", depth: 1 },
	], now);
	const comp = factory!({ requestRender() {} }, plain);
	assert.match(comp.render(120)[0]!, /\/legion stop \[name\|all\]/, "railway: hint while live");
	board.clear();
});

test("status board: tree strip shows short /legion stop hint while live", async () => {
	const { createStatusBoard } = await import("../../src/tui/status.ts");
	let factory: ((tui: { requestRender(): void }, theme: unknown) => { render(w: number): string[] }) | undefined;
	const plain = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const board = createStatusBoard({ strip: "tree" });
	board.bind({ hasUI: true, ui: { theme: plain, setStatus() {}, setWidget(_k: string, c: unknown) { factory = typeof c === "function" ? c as never : undefined; } } } as never);
	const now = Date.now();
	board.paint([
		{ name: "centurion-0", agent: "centurion", state: "running", startedAt: now - 60_000, nodeId: "root", parentId: null, depth: 0 },
		{ name: "scout-1", agent: "scout", state: "running", startedAt: now - 30_000, nodeId: "root.s", parentId: "root", depth: 1 },
	], now);
	const lines = factory!({ requestRender() {} }, plain).render(120);
	assert.match(lines[1]!, /\/legion stop$/, "tree strip short hint on its own row");
	assert.doesNotMatch(lines.join("\n"), /name\|all/);
	board.clear();
});
