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
