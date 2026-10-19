import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import {
	applyStatus,
	createStatusBoard,
	formatBusyLabel,
	formatAgentElapsed,
	formatElapsed,
	formatWidgetLines,
	statusTotals,
	SAME_TURN_START_MS,
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
	// v4 dropped the `· cursor` label, so the model id carries the extra width
	// this replica needs to stay a 73-column headline on a 66-column terminal.
	model: "auto-smart[optimize_for=balanced]:max:balanced",
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

function mouseEvent(
	type: TuiMouseEvent["type"],
	y: number,
	button: TuiMouseEvent["button"] = "left",
): TuiMouseEvent {
	return {
		type,
		button,
		x: 1,
		y,
		screenX: 1,
		screenY: y,
		width: 120,
		height: 10,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

function activeTreeNode(nodeId: string, name: string): StatusEntry[] {
	return [
		{ name: "root", nodeId: "root", parentId: null, depth: 0, agent: "ceo", state: "working", startedAt: 0 },
		{ name, nodeId, parentId: "root", depth: 1, agent: "worker", state: "working", startedAt: 1 },
	];
}

function mountStatusWidget(entries: StatusEntry[], opened: string[]): {
	board: ReturnType<typeof createStatusBoard>;
	component: ReturnType<WidgetFactory>;
} {
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
	const board = createStatusBoard({ onNodeClick: (nodeId) => opened.push(nodeId) });
	board.bind(ctx);
	board.paint(entries, 5_000);
	assert.equal(typeof factory, "function");
	return { board, component: factory!(tui, theme) };
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

test("formatElapsed rounds to seconds and breaks out minutes and hours", () => {
	assert.equal(formatElapsed(0), "0s");
	assert.equal(formatElapsed(1_400), "1s");
	assert.equal(formatElapsed(12_499), "12s");
	assert.equal(formatElapsed(42_000), "42s");
	assert.equal(formatElapsed(59_600), "1m00s");
	assert.equal(formatElapsed((12 * 60 + 12) * 1_000), "12m12s");
	assert.equal(formatElapsed((12 * 60 + 2) * 1_000), "12m02s");
	assert.equal(formatElapsed((1 * 3600 + 3 * 60) * 1_000), "1h03m");
	assert.equal(formatElapsed(3_600_000), "1h00m");
	assert.equal(formatElapsed((1 * 3600 + 3 * 60 + 12) * 1_000), "1h03m");
	assert.equal(formatElapsed(-1_500), "0s");
});

test("formatBusyLabel ignores the ledger root (not an async child agent)", () => {
	const root: StatusEntry = {
		name: "root",
		nodeId: "root",
		parentId: null,
		depth: 0,
		agent: "ceo",
		state: "running",
		startedAt: 0,
	};
	assert.equal(formatBusyLabel([root]), undefined, "the parent session itself is not an async child agent");
});

test("formatBusyLabel lists live children without a leading emoji", () => {
	assert.equal(formatBusyLabel([]), undefined);
	assert.equal(formatBusyLabel(entries.slice(0, 1)), "1 subagent (worker-0)");
	assert.equal(
		formatBusyLabel(entries),
		"2 subagents (worker-0, reviewer-1)",
	);
});

test("formatWidgetLines keeps the compact roster when no extra fields are set", () => {
	assert.deepEqual(formatWidgetLines([], 5_000), []);
	assert.deepEqual(formatWidgetLines(entries.slice(0, 1), 5_000), [
		"● worker-0 (worker) · 4s",
		"  ⎿  working",
	]);
	const lines = formatWidgetLines(entries, 5_000);
	assert.equal(lines[0], "● Async agents");
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
					name: "worker-2",
					agent: "reviewer",
					state: "working",
					startedAt: 1_000,
					model: "cb/gpt-5.1",
					herdrStatus: "working",
					lastTools: ["edit"],
				},
			],
			5_000,
		),
		[
			// v4 has one kind, so the headline no longer repeats it.
			"● worker-2 (reviewer) · cb/gpt-5.1 · 4s",
			"  ⎿  working · edit",
		],
	);
});

test("formatWidgetLines shows cumulative tokens and output/generation throughput", () => {
	const lines = formatWidgetLines(
		[{ name: "worker-0", agent: "worker", state: "working", startedAt: 0, tokensTotal: 1_200, tokensOut: 600, generationMs: 2_000 }],
		5_000,
	);
	assert.match(lines[0] ?? "", /· 1\.2K tok$/);
	assert.match(lines[1] ?? "", /· 300 avg t\/s$/);
});

test("formatWidgetLines t/s uses generationMs not wall clock / finishedAt", () => {
	const lines = formatWidgetLines(
		[{ name: "worker-0", agent: "worker", state: "settled", startedAt: 0, finishedAt: 4_000, tokensTotal: 1_000, tokensOut: 400, generationMs: 2_000 }],
		5_000,
	);
	// 400 out / 2s gen = 200 avg t/s; old wall formula would be 1000/4s = 250
	assert.match(lines[1] ?? "", /· 200 avg t\/s$/);
});

test("formatWidgetLines omits throughput without generationMs but keeps token headline", () => {
	const lines = formatWidgetLines(
		[{ name: "worker-0", agent: "worker", state: "working", startedAt: 0, tokensTotal: 800, tokensOut: 400 }],
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

test("formatWidgetLines computes throughput from output over generationMs", () => {
	const lines = formatWidgetLines(
		[{ name: "worker-0", agent: "worker", state: "working", startedAt: 0, tokensTotal: 1_200, tokensOut: 1_200, generationMs: 1_500 }],
		5_000,
	);
	assert.match(lines[1] ?? "", /· 800 avg t\/s$/);
});

test("formatWidgetLines includes throughput at exactly one second of generation", () => {
	const lines = formatWidgetLines(
		[{ name: "worker-0", agent: "worker", state: "working", startedAt: 0, tokensTotal: 1_000, tokensOut: 1_000, generationMs: 1_000 }],
		5_000,
	);
	assert.match(lines[1] ?? "", /· 1K avg t\/s$/);
});

test("formatWidgetLines shows current-turn elapsed beside the lifetime total", () => {
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
			"● worker-0 (worker) · 13m07s / 1h23m",
			"  ⎿  working · turn 4",
		],
	);
});

test("formatAgentElapsed keeps ticking after a turn settles and freezes when the agent ends", () => {
	const base = {
		name: "worker-0",
		agent: "worker",
		state: "working",
		startedAt: 0,
		turns: 3,
	} satisfies StatusEntry;
	const turnStartedAt = 60_000;

	// In flight: both clocks run.
	const inFlight = { ...base, currentTurnStartedAt: turnStartedAt };
	assert.equal(formatAgentElapsed(inFlight, 120_000), "1m00s / 2m00s");

	// Turn settled at 90s, agent still live: the clock reads "since the last
	// task started", so the quiet gap keeps counting (not 30s, not frozen).
	const settledTurn = { ...base, currentTurnStartedAt: turnStartedAt, currentTurnEndedAt: 90_000 };
	assert.equal(formatAgentElapsed(settledTurn, 150_000), "1m30s / 2m30s");
	assert.equal(
		formatWidgetLines([settledTurn], 150_000)[0],
		"● worker-0 (worker) · 1m30s / 2m30s",
	);

	// The agent itself ended at 150s: both clocks clamp there.
	const ended = { ...base, state: "settled", finishedAt: 150_000, currentTurnStartedAt: turnStartedAt, currentTurnEndedAt: 90_000 };
	assert.equal(formatAgentElapsed(ended, 150_000), "1m30s / 2m30s");
	assert.equal(formatAgentElapsed(ended, 300_000), "1m30s / 2m30s", "ended agent stops ticking");

	// The next turn resets the leading clock.
	const reset = { ...base, currentTurnStartedAt: 200_000 };
	assert.equal(formatAgentElapsed(reset, 200_000 + 42_000), "42s / 4m02s");
	assert.equal(formatAgentElapsed(reset, 200_000 + 47_000), "47s / 4m07s");

	// A turn that starts with the agent (round 1) collapses to the lifetime.
	// `turns: 1` must accompany `currentTurnStartedAt: 0`: base carries turns: 3.
	const longTurn = { ...base, turns: 1, currentTurnStartedAt: 0 };
	assert.equal(formatAgentElapsed(longTurn, (1 * 3600 + 3 * 60 + 12) * 1_000), "1h03m");

	// The spawn gap, for entries that report no turn count: the session's first
	// user message lands ~1s after the process spawn, so the two starts are not
	// byte-equal but it is still round 1.
	const noCount = { name: "w", agent: "worker", state: "working", startedAt: 0 } satisfies StatusEntry;
	assert.equal(
		formatAgentElapsed({ ...noCount, currentTurnStartedAt: 1_000 }, 17_000),
		"17s",
		"1s spawn gap must not print 16s / 17s",
	);
	assert.equal(
		formatAgentElapsed({ ...noCount, currentTurnStartedAt: SAME_TURN_START_MS }, 17_000),
		"17s",
		"at the tolerance edge still round 1",
	);
	assert.equal(
		formatAgentElapsed({ ...noCount, currentTurnStartedAt: SAME_TURN_START_MS + 1_000 }, 17_000),
		"11s / 17s",
		"past the tolerance it is a real second turn",
	);
});

test("formatWidgetLines omits current-turn elapsed without a start and freezes terminal entries", () => {
	const cases: Array<{ entry: StatusEntry; label: string }> = [
		{ label: "no turn start", entry: { name: "w", agent: "worker", state: "working", startedAt: 0, turns: 2 } },
		{ label: "settled turn", entry: { name: "w", agent: "worker", state: "working", startedAt: 0, turns: 2, currentTurnStartedAt: undefined } },
		{ label: "idle without a freeze point", entry: { name: "w", agent: "worker", state: "waiting", startedAt: 0, turns: 2, currentTurnStartedAt: 0 } },
	];
	for (const { entry, label } of cases) {
		const lines = formatWidgetLines([entry], 5_000_000).join("\n");
		assert.doesNotMatch(lines, / \/ /, `${label}: no current/total pair expected`);
		assert.match(lines, /turn 2/, `${label}: turn count stays`);
	}
	// A terminal entry with only a start freezes at finishedAt, not at now.
	// Round 1 (turns: 1) spans the whole life, so the two collapse to one value.
	const terminal = formatWidgetLines(
		[{ name: "w", agent: "worker", state: "settled", startedAt: 0, finishedAt: 42_000, turns: 1, currentTurnStartedAt: 0 }],
		5_000_000,
	);
	assert.equal(terminal[0], "● w (worker) · 42s");
	assert.match(terminal[1] ?? "", /turn 1$/);
	// Clock skew clamps to zero instead of going negative.
	const skewed = formatWidgetLines(
		[{ name: "w", agent: "worker", state: "working", startedAt: 0, turns: 2, currentTurnStartedAt: 9_999_999 }],
		5_000_000,
	);
	assert.match(skewed[0] ?? "", /0s/);
	assert.match(skewed[1] ?? "", /turn 2$/);
});

test("applyStatus paints above the editor without footer status", () => {
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
	assert.deepEqual(statuses, [], "footer N agents running removed (#192)");

	applyStatus(ctx, [], 5_000);
	const cleared = widgets[1] as { content: undefined };
	assert.equal(cleared.content, undefined);
	assert.deepEqual(statuses, [], "clearing the widget must not write footer status");
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
	assert.deepEqual(statuses, [], "status board must not write footer status (#192)");
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

test("status widget opens tree nodes only after a matching left press and click", () => {
	const opened: string[] = [];
	const { component } = mountStatusWidget(treeEntries(), opened);
	const lines = component.render(120);
	const centurionHeadline = lines.findIndex((line) => stripTerminalSequences(line).includes("● centurion"));
	assert.ok(centurionHeadline > 0, lines.join("\n"));
	assert.equal(component.handleMouse(mouseEvent("press", 0)), undefined, "the header press is not handled");
	assert.deepEqual(component.handleMouse(mouseEvent("press", centurionHeadline)), { handled: true });
	assert.deepEqual(component.handleMouse(mouseEvent("click", centurionHeadline + 1)), { handled: true }, "the detail row shares its node id");
	assert.deepEqual(opened, ["root.centurion"]);
	assert.equal(component.handleMouse(mouseEvent("click", centurionHeadline + 1)), undefined, "click without a fresh press has no latch");
	assert.deepEqual(opened, ["root.centurion"]);
});

test("status widget clears a node-click latch when any other row is pressed", () => {
	const opened: string[] = [];
	const { component } = mountStatusWidget(treeEntries(), opened);
	const lines = component.render(120);
	const centurionHeadline = lines.findIndex((line) => stripTerminalSequences(line).includes("● centurion"));
	assert.ok(centurionHeadline > 0, lines.join("\n"));
	assert.deepEqual(component.handleMouse(mouseEvent("press", centurionHeadline)), { handled: true });
	assert.equal(component.handleMouse(mouseEvent("press", 0)), undefined);
	assert.equal(component.handleMouse(mouseEvent("click", centurionHeadline)), undefined);
	assert.deepEqual(opened, []);
});

test("status widget ignores a click whose row differs from the pressed node", () => {
	const opened: string[] = [];
	const { component } = mountStatusWidget(treeEntries(), opened);
	const lines = component.render(120);
	const centurionHeadline = lines.findIndex((line) => stripTerminalSequences(line).includes("● centurion"));
	const workerHeadline = lines.findIndex((line) => stripTerminalSequences(line).includes("worker-a2 (worker)"));
	assert.ok(centurionHeadline > 0, lines.join("\n"));
	assert.ok(workerHeadline > centurionHeadline, lines.join("\n"));
	assert.deepEqual(component.handleMouse(mouseEvent("press", centurionHeadline)), { handled: true });
	assert.equal(component.handleMouse(mouseEvent("click", workerHeadline)), undefined);
	assert.deepEqual(opened, []);
});

test("status widget associates a collapsed tree row with its node id", () => {
	const opened: string[] = [];
	const { component } = mountStatusWidget(
		[
			{ name: "root", nodeId: "root", parentId: null, depth: 0, agent: "ceo", state: "working", startedAt: 0 },
			{ name: "terminal", nodeId: "root.terminal", parentId: "root", depth: 1, agent: "centurion", state: "settled", startedAt: 1 },
			{ name: "archived", nodeId: "root.terminal.archived", parentId: "root.terminal", depth: 2, agent: "worker", state: "settled", startedAt: 2 },
			// This active record keeps the terminal path visible by identity while
			// being a sibling in the rendered graph, leaving the terminal branch collapsed.
			{ name: "worker", nodeId: "root.terminal.archived.worker", parentId: "root", depth: 1, agent: "worker", state: "working", startedAt: 3 },
		],
		opened,
	);
	const lines = component.render(120);
	const collapsed = lines.findIndex((line) => stripTerminalSequences(line).includes("terminal +1 collapsed"));
	assert.ok(collapsed > 0, lines.join("\n"));
	assert.deepEqual(component.handleMouse(mouseEvent("press", collapsed)), { handled: true });
	assert.deepEqual(component.handleMouse(mouseEvent("click", collapsed)), { handled: true });
	assert.deepEqual(opened, ["root.terminal"]);
});

test("legacy flat status rows are not clickable", () => {
	const opened: string[] = [];
	const { component } = mountStatusWidget(entries, opened);
	const lines = component.render(120);
	assert.match(lines[0] ?? "", /Async agents/);
	assert.equal(component.handleMouse(mouseEvent("press", 0)), undefined);
	assert.equal(component.handleMouse(mouseEvent("press", 1)), undefined);
	assert.equal(component.handleMouse(mouseEvent("click", 1)), undefined);
	assert.deepEqual(opened, []);
});

test("status widget drops a pressed node when its row remaps after repaint", () => {
	const opened: string[] = [];
	const { board, component } = mountStatusWidget(activeTreeNode("root.x", "node-X"), opened);
	const initialLines = component.render(120).map(stripTerminalSequences);
	const xRow = initialLines.findIndex((line) => line.includes("● node-X"));
	assert.ok(xRow > 0, initialLines.join("\n"));
	assert.deepEqual(component.handleMouse(mouseEvent("press", xRow)), { handled: true });

	board.paint(activeTreeNode("root.y", "node-Y"), 6_000);
	const repaintedLines = component.render(120).map(stripTerminalSequences);
	assert.match(repaintedLines[xRow] ?? "", /node-Y/, repaintedLines.join("\n"));
	assert.equal(component.handleMouse(mouseEvent("click", xRow)), undefined);
	assert.deepEqual(opened, []);
});

test("status widget still opens a node when its row mapping survives repaint", () => {
	const opened: string[] = [];
	const { board, component } = mountStatusWidget(activeTreeNode("root.x", "node-X"), opened);
	const lines = component.render(120).map(stripTerminalSequences);
	const xRow = lines.findIndex((line) => line.includes("● node-X"));
	assert.ok(xRow > 0, lines.join("\n"));
	assert.deepEqual(component.handleMouse(mouseEvent("press", xRow)), { handled: true });

	board.paint(activeTreeNode("root.x", "node-X updated"), 6_000);
	const repaintedLines = component.render(120).map(stripTerminalSequences);
	assert.match(repaintedLines[xRow] ?? "", /node-X updated/, repaintedLines.join("\n"));
	assert.deepEqual(component.handleMouse(mouseEvent("click", xRow)), { handled: true });
	assert.deepEqual(opened, ["root.x"]);
});

test("status widget ignores right presses and wheel events", () => {
	const opened: string[] = [];
	const { component } = mountStatusWidget(activeTreeNode("root.x", "node-X"), opened);
	const lines = component.render(120).map(stripTerminalSequences);
	const xRow = lines.findIndex((line) => line.includes("● node-X"));
	assert.ok(xRow > 0, lines.join("\n"));

	assert.deepEqual(component.handleMouse(mouseEvent("press", xRow)), { handled: true });
	assert.equal(component.handleMouse(mouseEvent("press", xRow, "right")), undefined);
	assert.equal(component.handleMouse(mouseEvent("click", xRow)), undefined, "a right press clears the earlier left latch");
	assert.deepEqual(opened, []);

	for (const type of ["wheel", "release", "move", "drag"] as const) {
		assert.equal(component.handleMouse(mouseEvent(type, xRow)), undefined, `${type} events stay unhandled`);
	}
	assert.deepEqual(opened, []);
});

test("status widget keeps token overview headers non-clickable while node rows remain clickable", () => {
	const opened: string[] = [];
	const entries: StatusEntry[] = [
		{ name: "root", nodeId: "root", parentId: null, depth: 0, agent: "ceo", state: "working", startedAt: 0, tokensTotal: 900 },
		{ name: "node-X", nodeId: "root.x", parentId: "root", depth: 1, agent: "worker", state: "working", startedAt: 1, tokensTotal: 1_200 },
		{ name: "done", nodeId: "root.done", parentId: "root", depth: 1, agent: "worker", state: "settled", startedAt: 2, finishedAt: 3_000, tokensTotal: 800 },
	];
	const { component } = mountStatusWidget(entries, opened);
	const lines = component.render(120).map(stripTerminalSequences);
	assert.match(lines[0] ?? "", /Σ 2 agents/);
	assert.match(lines[0] ?? "", /2K tok/);
	assert.equal(component.handleMouse(mouseEvent("press", 0)), undefined);
	assert.equal(component.handleMouse(mouseEvent("click", 0)), undefined);
	assert.deepEqual(opened, []);

	const xRow = lines.findIndex((line) => line.includes("● node-X"));
	assert.ok(xRow > 0, lines.join("\n"));
	assert.deepEqual(component.handleMouse(mouseEvent("press", xRow)), { handled: true });
	assert.deepEqual(component.handleMouse(mouseEvent("click", xRow + 1)), { handled: true });
	assert.deepEqual(opened, ["root.x"]);
});

test("formatWidgetLines crash replica exceeds a 66-column terminal before truncation", () => {
	const [headline] = formatWidgetLines([crashEntry], 0);
	assert.equal(
		headline,
		"● search-0 (search) · auto-smart[optimize_for=balanced]:max:balanced · 0s",
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
	assert.match(lines[0] ?? "", /^● worker-0 \(worker\) · (?:\d+s|\d+m\d{2}s|\d+h\d{2}m)$/);
	assert.equal(lines[1], "  ⎿  working");
	assert.ok(!(lines[0] ?? "").includes("…") && !(lines[0] ?? "").includes("..."));
});

test("formatAgentElapsed drops a leading clock that repeats the lifetime", () => {
	const base = { name: "w", agent: "worker", state: "working", startedAt: 0 } satisfies StatusEntry;
	// Round 1: the turn starts when the agent starts, so both clocks agree and
	// `1m19s / 1m19s` would print the same fact twice.
	assert.equal(formatAgentElapsed({ ...base, currentTurnStartedAt: 0 }, 79_000), "1m19s");
	assert.equal(formatAgentElapsed({ ...base, currentTurnStartedAt: 0 }, 600_000), "10m00s");
	// A later turn (or a turn that started after the agent) is a real second fact.
	assert.equal(formatAgentElapsed({ ...base, currentTurnStartedAt: 10_000 }, 79_000), "1m09s / 1m19s");
	// No turn start at all: lifetime only (unchanged).
	assert.equal(formatAgentElapsed(base, 79_000), "1m19s");
});
