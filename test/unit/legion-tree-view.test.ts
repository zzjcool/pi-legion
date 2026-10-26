import assert from "node:assert/strict";
import { test } from "node:test";
import { getOsc8LinkAtColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createTreeView, type TreeNodeSnapshot } from "../../src/tui/tree-view.ts";

const BASE_TIME = 1_000;

function treeFixture(): TreeNodeSnapshot[] {
	return [
		node("root", null, "root", 0, "root", "running"),
		node("root.centurion", "root", "centurion", 1, "centurion", "running"),
		node("root.centurion.worker-a2", "root.centurion", "worker-a2", 2, "worker", "running"),
		node(
			"root.centurion.worker-a2.deep-manager",
			"root.centurion.worker-a2",
			"deep-manager",
			3,
			"centurion",
			"settled",
		),
		node(
			"root.centurion.worker-a2.deep-manager.deep-worker",
			"root.centurion.worker-a2.deep-manager",
			"deep-worker",
			4,
			"worker",
			"settled",
		),
		{
			...node("root.centurion.peer", "root.centurion", "peer", 2, "worker", "settled"),
			createdAt: BASE_TIME + 201,
			updatedAt: BASE_TIME + 201,
		},
	];
}

function node(
	id: string,
	parentId: string | null,
	name: string,
	depth: number,
	role: string,
	status: TreeNodeSnapshot["status"],
): TreeNodeSnapshot {
	const timestamp = BASE_TIME + depth * 100;
	return {
		id,
		parentId,
		name,
		role,
		kind: "pi",
		depth,
		runId: null,
		sessionFile: null,
		worktreePath: null,
		model: "provider/model",
		team: null,
		status,
		phase: status === "running" ? "implementing" : null,
		phaseSince: null,
		reworkCount: 0,
		contractPath: null,
		taskSummary: null,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

test("OSC 8 links bind repeated node names to the id on their own tree rows", () => {
	const nodes = [
		node("root", null, "root", 0, "root", "running"),
		node("root.alpha", "root", "alpha", 1, "centurion", "running"),
		node("root.alpha.worker", "root.alpha", "worker", 2, "worker", "running"),
		node("root.beta", "root", "beta", 1, "centurion", "running"),
		node("root.beta.worker", "root.beta", "worker", 2, "worker", "running"),
	];
	const view = createTreeView({ nodes });
	try {
		const rows = view.render(120).filter((line) => stripTerminalSequences(line).includes("● worker (worker)"));
		assert.equal(rows.length, 2, "each same-named worker has its own rendered tree row");
		const targets = rows.map((line) => {
			const plain = stripTerminalSequences(line);
			return getOsc8LinkAtColumn(line, plain.indexOf("● worker") + 2);
		});
		assert.deepEqual(targets, [
			"pi-legion://node/root.alpha.worker",
			"pi-legion://node/root.beta.worker",
		]);
	} finally {
		view.dispose();
	}
});

test("tree view default folding is independent of snapshot/event arrival order", () => {
	const nodes = treeFixture().map((entry) =>
		entry.id === "root.centurion.worker-a2.deep-manager.deep-worker"
			? { ...entry, status: "running" as const }
			: entry,
	);
	const launched = {
		nodeId: "root.centurion.worker-a2.deep-manager.deep-worker",
		type: "node_launched" as const,
		data: null,
		ts: BASE_TIME + 5_000,
	};
	const fromOrderedSnapshot = createTreeView({ nodes, events: [launched] });
	const fromReversedSnapshot = createTreeView({ nodes: [...nodes].reverse() });
	try {
		fromReversedSnapshot.applyEvent(launched);
		assert.deepEqual(
			fromReversedSnapshot.getState().expandedIds,
			fromOrderedSnapshot.getState().expandedIds,
		);
		assert.deepEqual(
			fromReversedSnapshot.getState().visibleIds,
			fromOrderedSnapshot.getState().visibleIds,
		);
	} finally {
		fromOrderedSnapshot.dispose();
		fromReversedSnapshot.dispose();
	}
});

test("tree view folds settled nodes below depth two and displays one collapsed row", () => {
	const view = createTreeView({ nodes: treeFixture(), now: () => BASE_TIME + 5_000 });
	try {
		const lines = view.render(100);
		assert.equal(view.isExpanded("root"), true);
		assert.equal(view.isExpanded("root.centurion"), true);
		assert.equal(view.isExpanded("root.centurion.worker-a2"), true);
		assert.equal(view.isExpanded("root.centurion.worker-a2.deep-manager"), false);
		assert.ok(
			lines.some((line) => stripTerminalSequences(line).includes("▸ deep-manager +1 collapsed")),
			"the depth-three branch is represented by one correctly linked collapsed row",
		);
		assert.ok(!lines.some((line) => line.includes("deep-worker")));
	} finally {
		view.dispose();
	}
});

test("tree view ignores unrelated mail events when preserving machine status timestamps", () => {
	const view = createTreeView({ nodes: treeFixture(), now: () => BASE_TIME + 5_000 });
	try {
		view.applyEvent({
			nodeId: "root.centurion.peer",
			type: "mail_delivered",
			data: { messageId: 1 },
			ts: BASE_TIME + 100_000,
		});
		const peerLine = view.render(100).find((line) => stripTerminalSequences(line).includes("peer (worker)"));
		assert.ok(peerLine);
		assert.match(stripTerminalSequences(peerLine), /peer \(worker\).*0s/);
	} finally {
		view.dispose();
	}
});

test("process agent_settled does not settle the Legion node or replace its node timestamp", () => {
	const nodes = treeFixture().map((entry) =>
		entry.id === "root.centurion.worker-a2.deep-manager.deep-worker"
			? { ...entry, status: "running" as const, phase: "implementing" }
			: entry,
	);
	const baseline = createTreeView({ nodes, now: () => BASE_TIME + 6_000 });
	const view = createTreeView({ nodes, now: () => BASE_TIME + 6_000 });
	try {
		const baselineLines = baseline.render(100).map(stripTerminalSequences);
		const baselineIndex = baselineLines.findIndex((line) => line.includes("deep-worker (worker)"));
		assert.ok(baselineIndex >= 0);

		view.applyEvent({
			nodeId: "root.centurion.worker-a2.deep-manager.deep-worker",
			type: "agent_settled",
			data: null,
			ts: BASE_TIME + 100_000,
		});
		const lines = view.render(100).map(stripTerminalSequences);
		const headlineIndex = lines.findIndex((line) => line.includes("deep-worker (worker)"));
		assert.ok(headlineIndex >= 0);
		assert.equal(lines[headlineIndex], baselineLines[baselineIndex]);
		assert.equal(lines[headlineIndex + 1], baselineLines[baselineIndex + 1]);
		assert.match(lines[headlineIndex + 1] ?? "", /implementing/);
	} finally {
		baseline.dispose();
		view.dispose();
	}
});

test("tree view forcibly expands a running descendant's complete path", () => {
	const view = createTreeView({ nodes: treeFixture(), now: () => BASE_TIME + 5_000 });
	try {
		view.applyEvent({
			nodeId: "root.centurion.worker-a2.deep-manager.deep-worker",
			type: "node_resumed",
			data: null,
			ts: BASE_TIME + 6_000,
		});
		assert.equal(view.isExpanded("root.centurion.worker-a2.deep-manager"), true);
		assert.ok(view.getState().visibleIds.includes("root.centurion.worker-a2.deep-manager.deep-worker"));

		view.handleInput?.("j");
		view.handleInput?.("j");
		view.handleInput?.("j");
		view.handleInput?.("\r");
		assert.equal(
			view.isExpanded("root.centurion.worker-a2.deep-manager"),
			true,
			"Enter cannot fold a subtree while any descendant is running",
		);
	} finally {
		view.dispose();
	}
});

test("tree view self-pages, clamps page boundaries, and keeps keyboard selection visible", () => {
	const nodes = [node("root", null, "root", 0, "root", "running")];
	for (let index = 0; index < 20; index++) {
		const childName = `worker-${index}`;
		const childId = `root.${childName}`;
		nodes.push({
			...node(childId, "root", childName, 1, "worker", "settled"),
			createdAt: BASE_TIME + 100 + index,
			updatedAt: BASE_TIME + 100 + index,
		});
		if (index > 0) {
			nodes.push(node(`${childId}.leaf`, childId, "leaf", 2, "worker", "settled"));
		}
	}
	const view = createTreeView({ nodes, terminalRows: 8 });
	try {
		const page = view.render(100);
		const initial = view.getState();
		assert.equal(page.length, 8, "render is capped by injected terminal rows");
		assert.equal(initial.pageSize, 7);
		assert.equal(initial.scrollTop, 0);
		assert.ok(initial.maxScrollTop > 0);

		view.handleInput?.("\u001b[6~");
		const afterPageDown = view.getState();
		assert.equal(afterPageDown.scrollTop, afterPageDown.pageSize);
		assert.ok(afterPageDown.scrollTop <= afterPageDown.maxScrollTop);
		assert.equal(view.render(100).length, 8);
		assert.ok(view.render(100).some((line) => line.includes("worker-")));

		view.handleInput?.("\u001b[5~");
		assert.equal(view.getState().scrollTop, 0, "PageUp clamps to the first page");
		view.handleInput?.("\u001b[5~");
		assert.equal(view.getState().scrollTop, 0, "repeated PageUp cannot overscroll");

		for (let index = 0; index < 10; index++) view.handleInput?.("j");
		const selected = view.getState();
		const selectedNodeStart = view.render(100).findIndex((line) => line.includes("❯"));
		assert.ok(selectedNodeStart >= 1, "selection marker remains in the visible page");
		assert.ok(selectedNodeStart < 8);
		assert.ok(selected.selectedId);
		view.handleInput?.("\u001b[6~");
		const beforeWheel = view.getState().scrollTop;
		view.handleMouse?.({
			type: "wheel",
			button: "none",
			x: 2,
			y: 3,
			screenX: 2,
			screenY: 3,
			width: 100,
			height: 8,
			shift: false,
			alt: false,
			ctrl: false,
			wheelDelta: -1,
		});
		assert.equal(view.getState().scrollTop, beforeWheel - 1, "negative wheel delta moves up to earlier rows");
		view.handleMouse?.({
			type: "wheel",
			button: "none",
			x: 2,
			y: 3,
			screenX: 2,
			screenY: 3,
			width: 100,
			height: 8,
			shift: false,
			alt: false,
			ctrl: false,
			wheelDelta: 1,
		});
		assert.equal(view.getState().scrollTop, beforeWheel, "positive wheel delta moves down to later rows");
		view.handleInput?.("\u001b[6~");
		view.handleInput?.("\u001b[6~");
		assert.equal(view.getState().scrollTop, view.getState().maxScrollTop, "PageDown clamps at the last page");
	} finally {
		view.dispose();
	}
});

test("tree keyboard state machine supports j/k, arrows, Enter, Space, search, Esc and q", () => {
	let doneCount = 0;
	const view = createTreeView({ nodes: treeFixture() }, () => doneCount++);
	view.render(100);
	assert.equal(view.getState().selectedId, "root");

	view.handleInput?.("j");
	assert.equal(view.getState().selectedId, "root.centurion");
	view.handleInput?.("\u001b[B");
	assert.equal(view.getState().selectedId, "root.centurion.worker-a2");
	view.handleInput?.("k");
	assert.equal(view.getState().selectedId, "root.centurion");
	view.handleInput?.("j");
	view.handleInput?.("j");
	assert.equal(view.getState().selectedId, "root.centurion.worker-a2.deep-manager");

	view.handleInput?.("\r");
	assert.equal(view.isExpanded("root.centurion.worker-a2.deep-manager"), true);
	view.handleInput?.(" ");
	assert.equal(view.isExpanded("root.centurion.worker-a2.deep-manager"), false);

	view.handleInput?.("/");
	for (const character of "deep-worker") view.handleInput?.(character);
	assert.equal(view.getState().searchMode, true);
	view.handleInput?.("\r");
	assert.equal(view.getState().searchMode, false);
	assert.equal(view.getState().selectedId, "root.centurion.worker-a2.deep-manager.deep-worker");
	assert.ok(view.getState().visibleIds.includes("root.centurion.worker-a2.deep-manager.deep-worker"));
	view.handleInput?.("\u001b");
	view.handleInput?.("q");
	assert.equal(doneCount, 1, "Esc/q complete the custom UI at most once");
	view.dispose();

	let qDoneCount = 0;
	const quitWithQ = createTreeView({ nodes: treeFixture() }, () => qDoneCount++);
	quitWithQ.handleInput?.("q");
	assert.equal(qDoneCount, 1);
	quitWithQ.dispose();
});

test("tree mouse click toggles the selected row head; narrow layouts never overflow", () => {
	const longNodes = treeFixture().map((entry) =>
		entry.id === "root.centurion.peer"
			? { ...entry, name: "very-long-worker-name-that-needs-truncation" }
			: entry,
	);
	const view = createTreeView({ nodes: longNodes, terminalRows: 9 });
	try {
		const wideLines = view.render(100);
		assert.equal(view.isExpanded("root.centurion.worker-a2.deep-manager"), false);
		const managerRow = wideLines.findIndex((line) => stripTerminalSequences(line).includes("▸ deep-manager +1 collapsed"));
		assert.ok(managerRow > 0);
		const mouseResult = view.handleMouse?.({
			type: "click",
			button: "left",
			x: 4,
			y: managerRow,
			screenX: 4,
			screenY: managerRow,
			width: 100,
			height: wideLines.length,
			shift: false,
			alt: false,
			ctrl: false,
		});
		assert.ok(mouseResult?.handled);
		assert.equal(view.getState().selectedId, "root.centurion.worker-a2.deep-manager");
		assert.equal(view.isExpanded("root.centurion.worker-a2.deep-manager"), true);

		const narrowLines = view.render(18);
		assert.ok(narrowLines.every((line) => visibleWidth(line) <= 18));
	} finally {
		view.dispose();
	}
});

test("tree view shows current-turn elapsed on turn_start and drops it on agent_settled", () => {
	const view = createTreeView({ nodes: treeFixture(), now: () => BASE_TIME + 5_000 });
	try {
		const lines = (): string[] => view.render(120).map(stripTerminalSequences);
		const detailLine = (): string | undefined => {
			const index = lines().findIndex((line) => line.includes("worker-a2 (worker)"));
			return index >= 0 ? lines()[index + 1] : undefined;
		};

		view.applyEvent({
			nodeId: "root.centurion.worker-a2",
			type: "turn_start",
			data: null,
			ts: BASE_TIME + 2_000,
		});
		assert.match(detailLine() ?? "", /turn 1 \(3s\)/);

		view.applyEvent({
			nodeId: "root.centurion.worker-a2",
			type: "agent_settled",
			data: null,
			ts: BASE_TIME + 3_000,
		});
		assert.match(detailLine() ?? "", /turn 1$/);
	} finally {
		view.dispose();
	}
});

test("tree view freezes current-turn elapsed at the terminal transition", () => {
	// A leaf node keeps its detail row after settling; a parent would collapse.
	const leaf = node("root.leaf", "root", "leaf", 1, "worker", "running");
	const view = createTreeView({
		nodes: [node("root", null, "root", 0, "root", "running"), leaf],
		now: () => BASE_TIME + 60_000,
	});
	try {
		view.applyEvent({
			nodeId: "root.leaf",
			type: "turn_start",
			data: null,
			ts: BASE_TIME + 2_000,
		});
		// Terminal transition lands long after the turn started; the frozen
		// suffix is measured to that transition, not to now().
		view.applyEvent({
			nodeId: "root.leaf",
			type: "node_settled",
			data: null,
			ts: BASE_TIME + 10_000,
		});
		const lines = view.render(120).map(stripTerminalSequences);
		const index = lines.findIndex((line) => line.includes("leaf (worker)"));
		assert.ok(index >= 0);
		assert.match(lines[index + 1] ?? "", /turn 1 \(8s\)/);
	} finally {
		view.dispose();
	}
});

test("tree view shows current-turn elapsed from a snapshot-provided turnStartedAt", () => {
	const nodes = treeFixture().map((entry) =>
		entry.id === "root.centurion.worker-a2"
			? { ...entry, turn: 7, turnStartedAt: BASE_TIME + 3_500 }
			: entry,
	);
	const view = createTreeView({ nodes, now: () => BASE_TIME + 5_000 });
	try {
		const lines = view.render(120).map(stripTerminalSequences);
		const index = lines.findIndex((line) => line.includes("worker-a2 (worker)"));
		assert.match(lines[index + 1] ?? "", /turn 7 \(2s\)/);
	} finally {
		view.dispose();
	}
});

test("D6: the tree's terminal set is derived — a terminal node freezes its clock, an active one does not", () => {
	// This file used to keep its own `TERMINAL_STATUSES`. For the six ledger
	// statuses the two happen to agree today, so the gain here is anti-drift, not
	// a behaviour change: `settled`/`failed`/`retired` now come from the same
	// authority as every other surface, so a future ledger status cannot be
	// terminal in the panel and non-terminal in the tree.
	const nodes = [
		node("root", null, "root", 0, "root", "running"),
		node("root.done", "root", "done", 1, "worker", "failed"),
		node("root.busy", "root", "busy", 1, "worker", "blocked"),
	];
	const view = createTreeView({ nodes, now: () => BASE_TIME + 60_000 });
	try {
		const lines = view.render(100).map(stripTerminalSequences);
		const done = lines.find((line) => line.includes("done (worker)"));
		const busy = lines.find((line) => line.includes("busy (worker)"));
		assert.ok(done && busy);
		// Terminal ⇒ the lifetime clock clamps at `updatedAt` (BASE_TIME + 100 for
		// depth 1) instead of running to now+60s.
		assert.match(done, /\b0s\b/, `a failed node's clock is frozen, got: ${done}`);
		// `blocked` is active (an approval gate), so its clock keeps running.
		assert.match(busy, /\b60s\b/, `a blocked node's clock still runs, got: ${busy}`);
	} finally {
		view.dispose();
	}
});

test("D5: `queued`/`idle` snapshot rows are never folded or dimmed as finished", () => {
	// `queued`/`idle` cannot reach this view through `NodeStatus` (D9 keeps them
	// out of the ledger set), but the partition must not misclassify one if a
	// snapshot ever carries it: calling it terminal would fold the subtree and
	// freeze the clock for work that has not even started. The cast is the point
	// of the test — it exercises the union the derived sets add for exactly this
	// hypothetical.
	for (const pending of ["queued", "idle"] as const) {
		const nodes = [
			node("root", null, "root", 0, "root", "running"),
			{ ...node("root.p", "root", "p", 1, "worker", "running"), status: pending as TreeNodeSnapshot["status"] },
			{ ...node("root.p.child", "root.p", "child", 2, "worker", "running"), status: pending as TreeNodeSnapshot["status"] },
		];
		const view = createTreeView({ nodes, now: () => BASE_TIME + 60_000 });
		try {
			assert.equal(view.isExpanded("root.p"), true, `${pending}: a pending parent is not folded as terminal`);
			const lines = view.render(100).map(stripTerminalSequences);
			const row = lines.find((line) => line.includes("p (worker)"));
			assert.ok(row, `${pending}: row rendered`);
			assert.match(row, /\b60s\b/, `${pending}: clock keeps running (not terminal), got: ${row}`);
			assert.ok(lines.some((line) => line.includes("child (worker)")), `${pending}: subtree stays visible`);
		} finally {
			view.dispose();
		}
	}
});

test("#298: the selected team root shows its phase machine; unselected does not", () => {
	// The machine is only meaningful for the node that DECLARES it, and only when
	// that node is selected — otherwise every render would be a wall of config.
	const machine = {
		phases: [
			{ id: "recon", next: [{ to: "build", require: ["contract_file" as const] }] },
			{ id: "build", next: [{ to: "done", require: ["verdict_ok" as const] }] },
			{ id: "done", terminal: true, next: [] },
		],
	};
	const nodes: TreeNodeSnapshot[] = [
		{ ...node("root", null, "root", 0, "root", "running"), phase: "recon" },
		{
			...node("root.cent", "root", "cent", 1, "centurion", "running"),
			phase: "recon",
			phaseMachine: machine,
		},
	];

	const view = createTreeView({ nodes });
	const strip = (text: string) => stripTerminalSequences(text);
	const before = view.render(120).map(strip).join("\n");
	// Selection starts at the root, which declares nothing: no machine shown.
	assert.doesNotMatch(before, /→ build/);

	// Move onto the centurion row, which declares the machine.
	assert.ok(view.handleInput, "the tree exposes keyboard input");
	view.handleInput("j");
	const after = view.render(120).map(strip).join("\n");
	assert.match(after, /phases · current: recon/, "the declaring team root shows its machine");
	assert.match(after, /→ build/, "including the transition and its condition");
	assert.match(after, /contract_file/, "conditions are named, since they are what gates the move");
});
