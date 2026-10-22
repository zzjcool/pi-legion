import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Component, type OverlayHandle } from "@earendil-works/pi-tui";
import { createLegionEventBus, type LegionEventBus } from "../../src/extension/event-bus.ts";
import { registerLegionCommand, type RpcEventSource } from "../../src/extension/legion-commands.ts";
import type { LiveOverlayComponent } from "../../src/tui/live-overlay.ts";
import type { TreeNodeSnapshot } from "../../src/tui/tree-view.ts";
import type { SupervisorEvent } from "../../src/supervisor/types.ts";

// Unit tests run without the host Pi process that normally initializes theme.
initTheme("dark");

const NOW = 1_000_000;

function makeNode(
	id: string,
	parentId: string | null,
	name: string,
	depth: number,
): TreeNodeSnapshot {
	return {
		id,
		parentId,
		name,
		role: name === "root" ? "ceo" : "worker",
		kind: "pi",
		depth,
		runId: null,
		sessionFile: null,
		worktreePath: null,
		model: "test/model",
		team: null,
		status: "running",
		phase: null,
		phaseSince: null,
		reworkCount: 0,
		contractPath: null,
		taskSummary: null,
		createdAt: NOW - 5_000,
		updatedAt: NOW - 1_000,
	};
}

function testOverlayHandle(): OverlayHandle {
	return {
		hide() {},
		setHidden() {},
		isHidden: () => false,
		focus() {},
		unfocus() {},
		isFocused: () => false,
		getBounds: () => undefined,
	};
}

/**
 * Minimal `/legion <node>` harness.
 *
 * `treeNodes()` is the full-tree DB snapshot the live overlay takes on every bus
 * event (#261). It is a real recursive-CTE scan in production, so the only thing
 * the harness has to model is the call count — plus a mutable node list so a
 * status change can actually be observed after a refresh.
 */
function liveHarness() {
	const nodes = [
		makeNode("root", null, "root", 0),
		makeNode("root.worker", "root", "worker", 1),
	];
	let treeNodesCalls = 0;
	const bus: LegionEventBus = createLegionEventBus();
	const rpcSubscriptions: Array<{ name: string; options?: { includeTextDelta?: boolean } }> = [];
	const supervisor: RpcEventSource = {
		onEvent(name, _listener, options) {
			rpcSubscriptions.push({ name, ...(options ? { options } : {}) });
			return () => {};
		},
	};
	const runtime = {
		activeJobs: () => [{ name: "worker", nodeId: "root.worker", state: "working" }],
		treeNodes: () => {
			treeNodesCalls += 1;
			return nodes.map((node) => ({ ...node }));
		},
	};

	let component: LiveOverlayComponent | undefined;
	const ui = {
		custom<T>(
			factory: (
				tui: never,
				theme: never,
				keybindings: never,
				done: (result: T) => void,
			) => Component,
			options?: { onHandle?: (handle: OverlayHandle) => void },
		): Promise<T> {
			component = factory(
				{ requestRender() {}, terminal: { rows: 24 } } as never,
				{ fg: (_color: string, text: string) => text } as never,
				{} as never,
				() => {},
			) as unknown as LiveOverlayComponent;
			options?.onHandle?.(testOverlayHandle());
			return new Promise<T>(() => {});
		},
		notify() {},
	};

	let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
	const pi = {
		registerCommand(name: string, value: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			if (name === "legion") command = value;
		},
		getSettings() { return {}; },
		sendMessage() {},
	};
	registerLegionCommand(pi as never, { bus, runtime, supervisor });
	const ctx = { hasUI: true, mode: "tui", cwd: "/tmp", ui };

	return {
		bus,
		rpcSubscriptions,
		node: (id: string) => {
			const node = nodes.find((candidate) => candidate.id === id);
			assert.ok(node, `unknown node ${id}`);
			return node;
		},
		get treeNodesCalls() {
			return treeNodesCalls;
		},
		get component() {
			return component;
		},
		open: async (query: string) => {
			await command!.handler(query, ctx);
			assert.ok(component, "the overlay component was mounted");
			return component!;
		},
	};
}

const plain = (component: LiveOverlayComponent): string =>
	stripTerminalSequences(component.render(100).join("\n"));

/**
 * #261/H2: `text_delta` is one streamed token. It cannot change status, phase or
 * usage, so the full-tree snapshot is pure overhead — measured at 1.37 ms per
 * token at 120 nodes, on the host's main thread, for the whole life of the modal.
 *
 * Both halves are asserted: no tree snapshot *and* the listener still fires (the
 * delta must keep reaching the modal body, or the fix would freeze streaming —
 * the opposite of the goal).
 */
test("#261: a streamed token refreshes the transcript without re-snapshotting the tree", async () => {
	const harness = liveHarness();
	const overlay = await harness.open("worker");
	assert.ok(harness.treeNodesCalls > 0, "opening the modal takes an initial snapshot");
	assert.deepEqual(
		harness.rpcSubscriptions.map(({ name, options }) => ({ name, options })),
		[{ name: "worker", options: { includeTextDelta: true } }],
		"the RPC detail feed stays subscribed with text_delta enabled",
	);

	const snapshotsAtOpen = harness.treeNodesCalls;
	const deltas = Array.from({ length: 10 }, (_, index) => `t${index} `);
	for (const [index, delta] of deltas.entries()) {
		harness.bus.emit({ nodeId: "root.worker", type: "text_delta", data: { delta }, ts: NOW + index });
	}

	assert.equal(
		harness.treeNodesCalls,
		snapshotsAtOpen,
		`10 streamed tokens must take 0 full-tree snapshots (took ${harness.treeNodesCalls - snapshotsAtOpen})`,
	);
	// …and the listener still fired for every one of them.
	assert.equal(overlay.getState().streamingText, deltas.join(""), "every delta reached the listener");
	assert.match(plain(overlay), /t9/, "the streamed tail is rendered in the modal body");
});

/**
 * Control: without this, deleting `refresh()` entirely would still pass the test
 * above. A stored status event must snapshot the tree and pull the new status,
 * and a non-delta process event must keep refreshing too (the exclusion is
 * `text_delta`-only, not "all process events").
 */
test("#261 control: stored and non-delta process events still refresh the snapshot", async () => {
	const harness = liveHarness();
	const overlay = await harness.open("worker");
	assert.equal(overlay.getState().status, "running");

	harness.node("root.worker").status = "settled";
	const beforeStored = harness.treeNodesCalls;
	harness.bus.emit({ nodeId: "root.worker", id: 40, type: "node_settled", data: null, ts: NOW + 1 });
	assert.equal(harness.treeNodesCalls, beforeStored + 1, "a stored status event still takes one snapshot");
	assert.equal(overlay.getState().status, "settled", "the refresh actually pulled the new status");

	const beforeProcess = harness.treeNodesCalls;
	harness.bus.emit({ nodeId: "root.worker", type: "turn_start", data: null, ts: NOW + 2 });
	assert.equal(harness.treeNodesCalls, beforeProcess + 1, "non-delta process events still refresh");
});
