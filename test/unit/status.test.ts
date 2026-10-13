import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
	applyStatus,
	createStatusBoard,
	formatBusyLabel,
	formatElapsed,
	formatFooterStatus,
	formatWidgetLines,
	statusTotals,
	STATUS_FOOTER_KEY,
	STATUS_WIDGET_KEY,
	STATUS_WIDGET_PLACEMENT,
	type StatusEntry,
	type StatusUi,
	type WidgetFactory,
} from "../../src/tui/status.ts";

const entries: StatusEntry[] = [
	{ name: "worker-0", agent: "worker", state: "working", startedAt: 1_000 },
	{ name: "reviewer-1", agent: "reviewer", state: "working", startedAt: 2_000 },
];

/** Crash log replica: visible width 73 on a 66-column terminal. */
const crashEntry: StatusEntry = {
	name: "search-0",
	agent: "search",
	state: "working",
	startedAt: 0,
	kind: "cursor",
	model: "auto-smart[optimize_for=balanced]:max",
};

const theme = { fg: (_color: string, text: string) => text };
const ansiTheme = {
	fg(color: string, text: string) {
		const code = color === "accent" ? "36" : "90";
		return `\x1b[${code}m${text}\x1b[0m`;
	},
};

function assertLinesFit(lines: string[], width: number): void {
	for (const line of lines) {
		assert.ok(
			visibleWidth(line) <= width,
			`line exceeds width ${width}: visible=${visibleWidth(line)} raw=${JSON.stringify(line)}`,
		);
	}
}

function treeEntries(): StatusEntry[] {
	return [
		{
			name: "root",
			nodeId: "root",
			parentId: null,
			depth: 0,
			agent: "ceo",
			state: "working",
			startedAt: 0,
		},
		{
			name: "centurion",
			nodeId: "root.centurion",
			parentId: "root",
			depth: 1,
			agent: "centurion",
			state: "working",
			startedAt: 100,
		},
		{
			name: "worker-a2",
			nodeId: "root.centurion.worker-a2",
			parentId: "root.centurion",
			depth: 2,
			agent: "worker",
			state: "working",
			startedAt: 200,
		},
		{
			name: "deep-manager",
			nodeId: "root.centurion.worker-a2.deep-manager",
			parentId: "root.centurion.worker-a2",
			depth: 3,
			agent: "centurion",
			state: "settled",
			startedAt: 300,
		},
		{
			name: "deep-worker",
			nodeId: "root.centurion.worker-a2.deep-manager.deep-worker",
			parentId: "root.centurion.worker-a2.deep-manager",
			depth: 4,
			agent: "worker",
			state: "settled",
			startedAt: 400,
		},
	];
}

test("formatElapsed rounds to seconds", () => {
	assert.equal(formatElapsed(0), "0s");
	assert.equal(formatElapsed(1_400), "1s");
	assert.equal(formatElapsed(12_499), "12s");
});

test("formatFooterStatus is empty when nothing is running", () => {
	assert.equal(formatFooterStatus([]), undefined);
	assert.equal(formatFooterStatus(entries.slice(0, 1)), "1 agent running");
	assert.equal(formatFooterStatus(entries), "2 agents running");
	const root: StatusEntry = {
		name: "root",
		nodeId: "root",
		parentId: null,
		depth: 0,
		agent: "ceo",
		state: "running",
		startedAt: 0,
	};
	assert.equal(formatFooterStatus([root]), undefined, "the parent session itself is not an async child agent");
	assert.equal(formatBusyLabel([root]), undefined);
});

test("formatBusyLabel matches the herdr overlay copy", () => {
	assert.equal(formatBusyLabel([]), undefined);
	assert.equal(formatBusyLabel(entries.slice(0, 1)), "⏳ 1 subagent (worker-0)");
	assert.equal(
		formatBusyLabel(entries),
		"⏳ 2 subagents (worker-0, reviewer-1)",
	);
});

test("formatWidgetLines keeps the compact roster when no extra fields are set", () => {
	assert.deepEqual(formatWidgetLines([], 5_000), []);
	assert.deepEqual(formatWidgetLines(entries.slice(0, 1), 5_000), [
		"● worker-0 (worker) · 4s",
		"  ⎿  working",
	]);
	const lines = formatWidgetLines(entries, 5_000);
	assert.equal(lines[0], "● Async agents · herdr");
	assert.equal(lines[1], "├─ ● worker-0 (worker) · 4s");
	assert.equal(lines[2], "│    ⎿  working");
	assert.equal(lines[3], "└─ ● reviewer-1 (reviewer) · 3s");
	assert.equal(lines[4], "     ⎿  working");
});

test("formatWidgetLines renders a tree, folds deep completed subtrees, and opens running paths", () => {
	const entries = treeEntries();
	const lines = formatWidgetLines(entries, 5_000).map(stripTerminalSequences);
	// Live-panel semantics: the settled deep-manager/deep-worker branch has no
	// active descendant, so it ages out of the resident widget entirely (its
	// collapsed row included). Only the three live agents remain.
	assert.equal(lines[0], "⏳ Legion · 3 agents · 3 running");
	assert.ok(!lines.some((line) => line.includes("deep-manager")));
	assert.ok(!lines.some((line) => line.includes("deep-worker")));

	// A completed branch with a running descendant stays, force-expanded, and
	// the completed parent renders as waiting on downstream work.
	const runningDeep = entries.map((entry) =>
		entry.name === "deep-worker" ? { ...entry, state: "working" } : entry,
	);
	const expanded = formatWidgetLines(runningDeep, 5_000).map(stripTerminalSequences);
	assert.ok(expanded.some((line) => line.includes("deep-worker")));
	assert.ok(!expanded.some((line) => line.includes("deep-manager +1 collapsed")));
	assert.ok(expanded.some((line) => line.includes("deep-manager (centurion)")), "settled parent with live subtree stays visible");
	assert.ok(expanded.some((line) => line.includes("waiting")), "waiting-on-downstream state replaces the dead settled label");
	assert.equal(expanded[0], "⏳ Legion · 5 agents · 4 running");
});

test("formatWidgetLines clears completely once every agent is done", () => {
	const finished = treeEntries().map((entry) =>
		entry.name === "root" ? entry : { ...entry, state: "settled", finishedAt: 4_000 },
	);
	assert.deepEqual(formatWidgetLines(finished, 5_000), []);
});

test("formatWidgetLines renders 300 nodes within the refresh budget", () => {
	const entries: StatusEntry[] = [
		{
			name: "root",
			nodeId: "root",
			parentId: null,
			depth: 0,
			agent: "ceo",
			state: "working",
			startedAt: 0,
		},
	];
	for (let index = 1; index < 300; index += 1) {
		const parentId = index === 1 ? "root" : `root.worker-${index - 1}`;
		entries.push({
			name: `worker-${index}`,
			nodeId: `root.worker-${index}`,
			parentId,
			depth: index,
			agent: "worker",
			state: "working",
			startedAt: index,
		});
	}
	const start = performance.now();
	const lines = formatWidgetLines(entries, 5_000);
	const elapsedMs = performance.now() - start;
	assert.ok(lines.length >= 300);
	assert.ok(elapsedMs < 500, `300-node refresh took ${elapsedMs.toFixed(1)}ms`);
});

test("formatWidgetLines adds model, thinking, kind, tools, and worktree", () => {
	assert.deepEqual(
		formatWidgetLines(
			[
				{
					name: "worker-0",
					agent: "worker",
					state: "working",
					startedAt: 1_000,
					model: "cb/glm-5.3",
					thinking: "medium",
					turns: 2,
					lastTools: ["bash", "read"],
					worktreeBranch: "pi-subagent/worker-0-abcd",
				},
			],
			5_000,
		),
		[
			"● worker-0 (worker) · cb/glm-5.3:medium · 4s",
			"  ⎿  working · turn 2 · bash, read · wt worker-0-abcd",
		],
	);
	assert.deepEqual(
		formatWidgetLines(
			[
				{
					name: "cursor-0",
					agent: "reviewer",
					state: "working",
					startedAt: 1_000,
					kind: "cursor",
					model: "cursor/gpt-4.1",
					herdrStatus: "working",
					lastTools: ["edit"],
				},
			],
			5_000,
		),
		[
			"● cursor-0 (reviewer) · cursor · cursor/gpt-4.1 · 4s",
			"  ⎿  working · edit",
		],
	);
});

test("formatWidgetLines shows cumulative tokens and average throughput", () => {
	const lines = formatWidgetLines(
		[{ name: "worker-0", agent: "worker", state: "working", startedAt: 0, tokensTotal: 1_200 }],
		5_000,
	);
	assert.match(lines[0] ?? "", /· 1\.2K tok$/);
	assert.match(lines[1] ?? "", /· 240 t\/s$/);
});

test("formatWidgetLines uses finishedAt for terminal throughput", () => {
	const lines = formatWidgetLines(
		[{ name: "worker-0", agent: "worker", state: "settled", startedAt: 0, finishedAt: 4_000, tokensTotal: 1_000 }],
		5_000,
	);
	assert.match(lines[1] ?? "", /· 250 t\/s$/);
});

test("formatWidgetLines omits throughput below one second but keeps token headline", () => {
	const lines = formatWidgetLines(
		[{ name: "worker-0", agent: "worker", state: "working", startedAt: 4_500, tokensTotal: 800 }],
		5_000,
	);
	assert.match(lines[0] ?? "", /· 800 tok$/);
	assert.doesNotMatch(lines[1] ?? "", /t\/s/);
});

test("formatWidgetLines appends a session-wide tree overview when totals are supplied", () => {
	const entries: StatusEntry[] = [
		{
			name: "worker-0",
			nodeId: "root.worker-0",
			parentId: "root",
			depth: 1,
			agent: "worker",
			state: "working",
			startedAt: 0,
			tokensTotal: 1_200,
		},
		{
			name: "worker-1",
			nodeId: "root.worker-1",
			parentId: "root",
			depth: 1,
			agent: "worker",
			state: "working",
			startedAt: 0,
			tokensTotal: 800,
		},
		{
			name: "done",
			nodeId: "root.done",
			parentId: "root",
			depth: 1,
			agent: "worker",
			state: "settled",
			startedAt: 0,
			finishedAt: 4_000,
			tokensTotal: 1_000,
		},
	];
	const totals = statusTotals(entries);
	assert.deepEqual(totals, { agents: 3, tokensTotal: 3_000 });
	assert.equal(
		formatWidgetLines(entries, 5_000, totals)[0],
		"⏳ Legion · 2 agents · 2 running · Σ 3 agents · 3K tok",
	);
	assert.equal(formatWidgetLines(entries, 5_000)[0], "⏳ Legion · 2 agents · 2 running");
});

test("formatWidgetLines shows token totals without Sigma when every agent is live", () => {
	const entries: StatusEntry[] = [
		{
			name: "worker-0",
			nodeId: "root.worker-0",
			parentId: "root",
			depth: 1,
			agent: "worker",
			state: "working",
			startedAt: 0,
			tokensTotal: 1_200,
		},
		{
			name: "worker-1",
			nodeId: "root.worker-1",
			parentId: "root",
			depth: 1,
			agent: "worker",
			state: "working",
			startedAt: 0,
			tokensTotal: 800,
		},
		{
			name: "worker-2",
			nodeId: "root.worker-2",
			parentId: "root",
			depth: 1,
			agent: "worker",
			state: "working",
			startedAt: 0,
			tokensTotal: 1_000,
		},
	];
	const totals = statusTotals(entries);
	assert.deepEqual(totals, { agents: 3, tokensTotal: 3_000 });
	assert.equal(
		formatWidgetLines(entries, 5_000, totals)[0],
		"⏳ Legion · 3 agents · 3 running · 3K tok",
	);
});

test("formatWidgetLines computes throughput using the original 1.5-second duration", () => {
	const lines = formatWidgetLines(
		[{ name: "worker-0", agent: "worker", state: "working", startedAt: 0, tokensTotal: 1_200 }],
		1_500,
	);
	assert.match(lines[1] ?? "", /· 800 t\/s$/);
});

test("formatWidgetLines includes throughput at exactly one second", () => {
	const lines = formatWidgetLines(
		[{ name: "worker-0", agent: "worker", state: "working", startedAt: 0, tokensTotal: 1_000 }],
		1_000,
	);
	assert.match(lines[1] ?? "", /· 1K t\/s$/);
});

test("formatWidgetLines appends current-turn elapsed for live in-flight turns", () => {
	assert.deepEqual(
		formatWidgetLines(
			[
				{
					name: "worker-0",
					agent: "worker",
					state: "working",
					startedAt: 1_000,
					turns: 4,
					currentTurnStartedAt: 4_213_000,
				},
			],
			5_000_000,
		),
		[
			"● worker-0 (worker) · 4999s",
			"  ⎿  working · turn 4 (787s)",
		],
	);
});

test("formatWidgetLines omits current-turn elapsed without a start, once settled, or for terminal entries", () => {
	const cases: Array<{ entry: Parameters<typeof formatWidgetLines>[0][number]; label: string }> = [
		{ label: "no turn start", entry: { name: "w", agent: "worker", state: "working", startedAt: 0, turns: 2 } },
		{ label: "settled turn", entry: { name: "w", agent: "worker", state: "working", startedAt: 0, turns: 2, currentTurnStartedAt: undefined } },
		{ label: "terminal node", entry: { name: "w", agent: "worker", state: "settled", startedAt: 0, finishedAt: 1_000, turns: 2, currentTurnStartedAt: 0 } },
	];
	for (const { entry, label } of cases) {
		const lines = formatWidgetLines([entry], 5_000_000).join("\n");
		assert.doesNotMatch(lines, /turn \d+ \(/, `${label}: no elapsed suffix expected`);
		assert.match(lines, /turn 2/, `${label}: turn count stays`);
	}
	// Clock skew clamps to zero instead of going negative.
	const skewed = formatWidgetLines(
		[{ name: "w", agent: "worker", state: "working", startedAt: 0, turns: 2, currentTurnStartedAt: 9_999_999 }],
		5_000_000,
	).join("\n");
	assert.match(skewed, /turn 2 \(0s\)/);
});

test("applyStatus paints above the editor and in the footer", () => {
	const widgets: unknown[] = [];
	const statuses: unknown[] = [];
	const ctx: StatusUi = {
		hasUI: true,
		ui: {
			theme,
			setStatus(key, text) {
				statuses.push({ key, text });
			},
			setWidget(key, content, options) {
				widgets.push({ key, content, options });
			},
		},
	};
	applyStatus(ctx, entries, 5_000);
	assert.equal(widgets.length, 1);
	const widget = widgets[0] as {
		key: string;
		content: string[];
		options: { placement: string };
	};
	assert.equal(widget.key, STATUS_WIDGET_KEY);
	assert.equal(widget.options.placement, STATUS_WIDGET_PLACEMENT);
	assert.equal(widget.options.placement, "aboveEditor");
	assert.match(widget.content[0] ?? "", /Async agents/);
	assert.deepEqual(statuses, [
		{ key: STATUS_FOOTER_KEY, text: "2 agents running" },
	]);

	applyStatus(ctx, [], 5_000);
	const cleared = widgets[1] as { content: undefined };
	assert.equal(cleared.content, undefined);
	assert.deepEqual(statuses[1], { key: STATUS_FOOTER_KEY, text: undefined });
});

test("applyStatus is a no-op without UI", () => {
	let called = 0;
	applyStatus(
		{
			hasUI: false,
			ui: {
				theme,
				setStatus() {
					called += 1;
				},
				setWidget() {
					called += 1;
				},
			},
		},
		entries,
		5_000,
	);
	assert.equal(called, 0);
});

test("status board registers a persistent factory and then requestRender", () => {
	const widgets: unknown[] = [];
	const statuses: unknown[] = [];
	let renders = 0;
	const tui = { requestRender: () => { renders += 1; } };
	const ctx: StatusUi = {
		hasUI: true,
		ui: {
			theme,
			setStatus(key, text) {
				statuses.push({ key, text });
			},
			setWidget(key, content, options) {
				widgets.push({ key, content, options });
				if (typeof content === "function") {
					(content as WidgetFactory)(tui, theme);
				}
			},
		},
	};
	const board = createStatusBoard();
	board.bind(ctx);
	board.paint(entries, 5_000);
	assert.equal(widgets.length, 1);
	const first = widgets[0] as {
		content: WidgetFactory;
		options: { placement: string };
	};
	assert.equal(typeof first.content, "function");
	assert.equal(first.options.placement, "aboveEditor");
	const component = first.content(tui, theme);
	assert.match(component.render().join("\n"), /worker-0/);

	board.paint(entries, 6_000);
	assert.equal(widgets.length, 1, "must not remount the widget on every tick");
	assert.equal(renders, 1);

	board.paint([], 7_000);
	const cleared = widgets.at(-1) as { content: undefined };
	assert.equal(cleared.content, undefined);
	assert.deepEqual(statuses.at(-1), { key: STATUS_FOOTER_KEY, text: undefined });
});

test("status board totals count aged-out nodes but exclude the ledger root", () => {
	let factory: WidgetFactory | undefined;
	const tui = { requestRender() {} };
	const ctx: StatusUi = {
		hasUI: true,
		ui: {
			theme,
			setStatus() {},
			setWidget(_key, content) {
				if (typeof content === "function") factory = content;
			},
		},
	};
	const entries: StatusEntry[] = [
		{
			name: "root",
			nodeId: "root",
			parentId: null,
			depth: 0,
			agent: "ceo",
			state: "running",
			startedAt: 0,
			tokensTotal: 900,
		},
		{
			name: "worker-0",
			nodeId: "root.worker-0",
			parentId: "root",
			depth: 1,
			agent: "worker",
			state: "working",
			startedAt: 0,
			tokensTotal: 1_200,
		},
		{
			name: "worker-1",
			nodeId: "root.worker-1",
			parentId: "root",
			depth: 1,
			agent: "worker",
			state: "working",
			startedAt: 0,
			tokensTotal: 800,
		},
		{
			name: "done",
			nodeId: "root.done",
			parentId: "root",
			depth: 1,
			agent: "worker",
			state: "settled",
			startedAt: 0,
			finishedAt: 4_000,
			tokensTotal: 1_000,
		},
	];
	const board = createStatusBoard();
	board.bind(ctx);
	board.paint(entries, 5_000);
	assert.equal(typeof factory, "function");
	const lines = factory!(tui, theme).render(120).map(stripTerminalSequences);
	assert.equal(lines[0], "⏳ Legion · 2 agents · 2 running · Σ 3 agents · 3K tok");
});

test("formatWidgetLines crash replica exceeds a 66-column terminal before truncation", () => {
	const [headline] = formatWidgetLines([crashEntry], 0);
	assert.equal(
		headline,
		"● search-0 (search) · cursor · auto-smart[optimize_for=balanced]:max · 0s",
	);
	assert.equal(visibleWidth(headline ?? ""), 73);
	assert.ok(visibleWidth(headline ?? "") > 66);
});

test("status board render truncates crash-replica titles to terminal width", () => {
	let factory: WidgetFactory | undefined;
	const tui = { requestRender() {} };
	const ctx: StatusUi = {
		hasUI: true,
		ui: {
			theme,
			setStatus() {},
			setWidget(_key, content) {
				if (typeof content === "function") factory = content;
			},
		},
	};
	const board = createStatusBoard();
	board.bind(ctx);
	board.paint([{ ...crashEntry, tokensTotal: 1_200 }], 0);
	assert.equal(typeof factory, "function");
	const lines = factory!(tui, theme).render(66);
	assertLinesFit(lines, 66);
	assert.match(lines.join("\n"), /search-0/);
});

test("status board render truncates multi-child tree prefixes and ANSI colors", () => {
	let factory: WidgetFactory | undefined;
	const tui = { requestRender() {} };
	const ctx: StatusUi = {
		hasUI: true,
		ui: {
			theme: ansiTheme,
			setStatus() {},
			setWidget(_key, content) {
				if (typeof content === "function") factory = content;
			},
		},
	};
	const board = createStatusBoard();
	board.bind(ctx);
	board.paint(
		[
			crashEntry,
			{
				name: "reviewer-1",
				agent: "reviewer",
				state: "working",
				startedAt: 0,
				kind: "cursor",
				model: "auto-smart[optimize_for=balanced]:max",
			},
		],
		0,
	);
	const lines = factory!(tui, ansiTheme).render(66);
	assertLinesFit(lines, 66);
	assert.match(lines.join("\n"), /search-0/);
	assert.match(lines.join("\n"), /reviewer-1/);
	assert.ok(lines.some((line) => line.includes("\x1b[")));
});

test("status board keeps short titles intact on a wide terminal", () => {
	let factory: WidgetFactory | undefined;
	const tui = { requestRender() {} };
	const ctx: StatusUi = {
		hasUI: true,
		ui: {
			theme,
			setStatus() {},
			setWidget(_key, content) {
				if (typeof content === "function") factory = content;
			},
		},
	};
	const board = createStatusBoard();
	board.bind(ctx);
	board.paint(entries.slice(0, 1), 5_000);
	const lines = factory!(tui, theme).render(120);
	assertLinesFit(lines, 120);
	assert.match(lines[0] ?? "", /^● worker-0 \(worker\) · \d+s$/);
	assert.equal(lines[1], "  ⎿  working");
	assert.ok(!(lines[0] ?? "").includes("…") && !(lines[0] ?? "").includes("..."));
});
