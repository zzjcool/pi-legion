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
 *
 * `ui.custom` mirrors pi's `showExtensionCustom`: the factory receives a `done`
 * it can call, and the returned promise settles only when that `done` runs. A
 * mount that is never resolved is exactly the frozen-modal symptom of H1, so the
 * harness keeps every pending resolver addressable.
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

	interface Mount {
		component: LiveOverlayComponent;
		settled: boolean;
		resolvers: Array<() => void>;
		promise: Promise<void>;
	}
	const mounts: Mount[] = [];
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
			const mount: Mount = {
				component: undefined as unknown as LiveOverlayComponent,
				settled: false,
				resolvers: [],
				promise: undefined as unknown as Promise<void>,
			};
			mount.promise = new Promise<void>((resolve) => {
				mount.resolvers.push(resolve);
			});
			mount.component = factory(
				{ requestRender() {}, terminal: { rows: 24 } } as never,
				{ fg: (_color: string, text: string) => text } as never,
				{} as never,
				() => {
					mount.settled = true;
					for (const resolve of mount.resolvers.splice(0)) resolve();
				},
			) as unknown as LiveOverlayComponent;
			options?.onHandle?.(testOverlayHandle());
			mounts.push(mount);
			return mount.promise as unknown as Promise<T>;
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
	const controller = registerLegionCommand(pi as never, { bus, runtime, supervisor });
	const ctx = { hasUI: true, mode: "tui", cwd: "/tmp", ui };

	return {
		controller,
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
		/** Every `ui.custom` mount in call order, each with its own pending resolver. */
		mounts,
		get customCalls() {
			return mounts.length;
		},
		/** The command promise for one `/legion <node>` invocation. */
		handler: (args: string) => command!.handler(args, ctx),
		open: async (query: string) => {
			await command!.handler(query, ctx);
			const mount = mounts.at(-1);
			assert.ok(mount, "the overlay component was mounted");
			return mount.component;
		},
	};
}

const plain = (component: LiveOverlayComponent): string =>
	stripTerminalSequences(component.render(100).join("\n"));

/**
 * #261/H2: `text_delta` is one streamed token. The token carries no tree state, so
 * re-snapshotting the whole tree for it is pure overhead — measured p50 ≈0.95–1.09 ms
 * per call at 120 nodes, once per token for the whole life of the modal. The skipped
 * snapshot only defers usage/status pickup to the next non-delta event.
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

/**
 * A1: the source→modal render edge. The two tests above prove the bus→source
 * direction (snapshot taken / listener called); they never prove the modal
 * *renders* what arrives. Deleting live-overlay's `turn_start` /
 * `agent_settled` / `tool_call` branches in `handleEvent` used to leave both of
 * them green, so the entire non-delta process-event render path was unprotected.
 *
 * What each event actually paints is deliberately narrow (live-overlay.ts:705:
 * coarse facts are "retained for the test/state view" only). So the render
 * assertion targets what is genuinely on screen — the meta bar's turn counter —
 * rather than the activity array, which is a state projection and would let a
 * dead render path pass.
 */
test("#261 A1: non-delta process events reach the modal render path", async () => {
	const harness = liveHarness();
	const overlay = await harness.open("worker");
	assert.match(plain(overlay), /turn 0/, "the meta bar starts at turn 0");

	harness.bus.emit({ nodeId: "root.worker", type: "turn_start", data: null, ts: NOW + 1 });
	assert.equal(overlay.getState().turn, 1, "turn_start increments the modal's turn counter");
	assert.match(plain(overlay), /turn 1/, "the incremented turn is rendered in the meta bar");
	assert.deepEqual(overlay.getState().activity, ["↻ turn 1"], "turn_start appends the activity line");

	harness.bus.emit({ nodeId: "root.worker", type: "turn_start", data: null, ts: NOW + 2 });
	assert.equal(overlay.getState().turn, 2);
	assert.match(plain(overlay), /turn 2/, "a second turn_start advances the rendered counter");

	harness.bus.emit({ nodeId: "root.worker", type: "tool_call", data: { toolName: "read" }, ts: NOW + 3 });
	assert.deepEqual(overlay.getState().activity, ["↻ turn 1", "↻ turn 2", "⚙ read"], "tool_call renders its phase marker");

	harness.bus.emit({ nodeId: "root.worker", type: "agent_settled", data: null, ts: NOW + 4 });
	assert.equal(overlay.getState().activity.at(-1), "✓ agent turn settled", "agent_settled closes the turn");
});

/**
 * Part B / H1: `openLiveOverlay` had no same-node guard, while
 * `createStatusNodeOpener` did. Two opens of the same node mounted a second
 * host overlay; `controller.open()` closed the first session but could not
 * resolve the first `ui.custom()` promise, so the orphaned `/legion` command
 * never settled and pi queued every later prompt behind it — the reported
 * "page is there but frozen".
 */
test("#261 B: a repeated open of the same node does not mount a second overlay", async () => {
	const harness = liveHarness();
	const first = await harness.open("worker");
	assert.equal(harness.customCalls, 1);
	const firstMount = harness.mounts[0]!;

	await harness.handler("worker");
	assert.equal(harness.customCalls, 1, "the same node is not mounted twice");
	assert.equal(harness.mounts[0], firstMount, "the original mount is still the one standing");
	assert.equal(harness.controller.getCurrent()?.nodeId, "root.worker");

	// The guard must not swallow the pending promise: closing resolves it.
	first.handleInput?.("\u001b");
	await firstMount.promise;
	assert.equal(firstMount.settled, true, "the previously-pending command promise still settles");
	assert.equal(first.getState().open, false);
});

test("#261 B control: opening a different node still mounts a second overlay", async () => {
	const harness = liveHarness();
	const worker = await harness.open("worker");
	assert.equal(harness.customCalls, 1);

	const other = await harness.open("root");
	assert.equal(harness.customCalls, 2, "the guard must not over-block a genuinely different node");
	assert.equal(harness.controller.getCurrent()?.nodeId, "root");
	assert.equal(worker.getState().open, false, "switching nodes closes the previous session");

	other.handleInput?.("\u001b");
	await harness.mounts[1]!.promise;
	assert.equal(harness.controller.getCurrent(), undefined);
});
