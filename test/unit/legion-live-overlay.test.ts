import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createLiveOverlay,
	type LiveOverlayEvent,
	type LiveOverlayListener,
	type LiveOverlayNode,
	type LiveOverlaySubscription,
	type LiveOverlaySource,
} from "../../src/tui/live-overlay.ts";
import type { OverlayHandle } from "@earendil-works/pi-tui";

class FakeOverlaySource implements LiveOverlaySource {
	readonly listeners = new Map<LiveOverlaySubscription, { nodeId: string; listener: LiveOverlayListener }>();
	backfill?: LiveOverlaySource["backfill"];
	subscribeCount = 0;
	unsubscribeCount = 0;
	private nextSubscription = 0;
	private readonly nodes = new Map<string, LiveOverlayNode>([
		[
			"root.worker",
			{
				id: "root.worker",
				name: "worker",
				role: "worker",
				model: "test/model",
				status: "running",
				createdAt: 1_000,
				updatedAt: 1_000,
			},
		],
		[
			"root.other",
			{
				id: "root.other",
				name: "other",
				role: "worker",
				model: null,
				status: "running",
				createdAt: 1_000,
				updatedAt: 1_000,
			},
		],
	]);

	subscribe(nodeId: string, listener: LiveOverlayListener): LiveOverlaySubscription {
		this.subscribeCount++;
		const token = (() => this.nextSubscription++) as LiveOverlaySubscription;
		this.listeners.set(token, { nodeId, listener });
		return token;
	}

	unsubscribe(subscription: LiveOverlaySubscription): void {
		this.unsubscribeCount++;
		this.listeners.delete(subscription);
	}

	getNode(nodeId: string): LiveOverlayNode | undefined {
		return this.nodes.get(nodeId);
	}

	emit(nodeId: string, event: LiveOverlayEvent): void {
		for (const { nodeId: subscribedNode, listener } of this.listeners.values()) {
			if (subscribedNode === nodeId) listener({ ...event, nodeId });
		}
	}
}

test("live overlay subscribes only when opened for the requested node and Esc unsubscribes", () => {
	const source = new FakeOverlaySource();
	const overlay = createLiveOverlay(source);
	assert.equal(source.subscribeCount, 0, "creating the controller is inert");

	let doneCount = 0;
	const component = overlay.open("root.worker", { done: () => doneCount++ });
	assert.equal(source.subscribeCount, 1);
	assert.equal(source.listeners.size, 1);
	assert.equal([...source.listeners.values()][0]?.nodeId, "root.worker");
	let hideCount = 0;
	const overlayHandle: OverlayHandle = {
		hide() {
			hideCount++;
		},
		setHidden() {},
		isHidden: () => false,
		focus() {},
		unfocus() {},
		isFocused: () => false,
		getBounds: () => undefined,
	};
	component.attachOverlayHandle(overlayHandle);

	component.handleInput?.("\u001b");
	assert.equal(source.unsubscribeCount, 1);
	assert.equal(source.listeners.size, 0);
	assert.equal(hideCount, 1, "Esc hides the attached overlay handle");
	assert.equal(component.getState().open, false);
	component.handleInput?.("\u001b");
	component.dispose();
	assert.equal(source.unsubscribeCount, 1, "close and dispose are idempotent");
	assert.equal(doneCount, 1);
	assert.equal(overlay.getCurrent(), undefined);
});

test("live overlay streams text/tool/settled events into a bounded recent-activity window", () => {
	const source = new FakeOverlaySource();
	const overlay = createLiveOverlay(source);
	const component = overlay.open("root.worker", { maxLines: 3, now: () => 5_000 });
	try {
		assert.equal(source.subscribeCount, 1);
		source.emit("root.other", { type: "text_delta", delta: "ignored" });
		assert.deepEqual(component.getState().activity, []);
		source.emit("root.worker", { type: "text_delta", delta: "hello " });
		source.emit("root.worker", { type: "text_delta", delta: "world" });
		source.emit("root.worker", {
			type: "message_update",
			updateType: "toolcall_start",
			toolName: "read",
		});
		source.emit("root.worker", { type: "turn_start" });
		source.emit("root.worker", { type: "agent_settled", ts: 4_000 });

		const state = component.getState();
		assert.equal(state.open, true);
		assert.equal(state.status, "running", "RPC turn settlement does not settle the Legion node");
		assert.equal(state.turn, 1);
		assert.ok(state.activity.length <= 3);
		assert.deepEqual(state.activity, ["⚙ read", "↻ turn 1", "✓ agent turn settled"]);
		const rendered = component.render(100).join("\n");
		assert.match(rendered, /worker \(worker\)/);
		assert.match(rendered, /running/);
		assert.match(rendered, /agent turn settled/);
		assert.doesNotMatch(rendered, /ignored/);
	} finally {
		component.close();
	}
});

test("opening a different node closes the old subscription, and done runs once on Esc", () => {
	const source = new FakeOverlaySource();
	const overlay = createLiveOverlay(source);
	let doneCount = 0;
	const first = overlay.open("root.worker", { done: () => doneCount++ });
	const second = overlay.open("root.other");
	assert.equal(first.getState().open, false);
	assert.equal(source.subscribeCount, 2);
	assert.equal(source.unsubscribeCount, 1);
	assert.equal(source.listeners.size, 1);

	second.handleInput?.("\u001b");
	assert.equal(source.unsubscribeCount, 2);
	assert.equal(source.listeners.size, 0);
	assert.equal(doneCount, 1, "replacing an overlay closes the old session and runs its completion callback");
	assert.equal(overlay.getCurrent(), undefined);

	const third = overlay.open("root.worker", { done: () => doneCount++ });
	third.handleInput?.("\u001b");
	assert.equal(doneCount, 2);
});

test("live overlay synchronously backfills safe activity before subscribing without requesting a render", () => {
	const source = new FakeOverlaySource();
	const overlay = createLiveOverlay(source);
	const requestedTurns: number[] = [];
	let requestRenderCount = 0;
	const component = overlay.open("root.worker", {
		maxBackfillTurns: 2,
		backfill(nodeId, maxBackfillTurns) {
			assert.equal(nodeId, "root.worker");
			assert.equal(source.subscribeCount, 0, "history is loaded before the live event subscription");
			requestedTurns.push(maxBackfillTurns);
			return {
				lines: ["▸ archived request", "\u001b[31marchived answer\u001b[0m", "⚙ read"],
				cursor: { turnCount: 1, assistantMessageCount: 1, fileSize: 128 },
			};
		},
		requestRender() {
			requestRenderCount++;
		},
	});
	try {
		assert.deepEqual(requestedTurns, [2]);
		assert.deepEqual(component.getState().activity, ["▸ archived request", "archived answer", "⚙ read"]);
		assert.equal(requestRenderCount, 0, "synchronous backfill is present on first render without scheduling another one");
		assert.equal(source.subscribeCount, 1);
	} finally {
		component.close();
	}
});

test("live overlay polls non-RPC backfill, renders deltas, and stops polling when closed", async () => {
	const source = new FakeOverlaySource();
	const stopPolling: string[] = [];
	const originalSubscribe = source.subscribe.bind(source);
	source.backfill = () => ({
		lines: ["▸ existing request"],
		cursor: { turnCount: 1, assistantMessageCount: 1, fileSize: 128 },
	});
	source.subscribe = (nodeId, listener) => {
		const subscription = originalSubscribe(nodeId, listener);
		subscription.pollBackfill = () => {
			stopPolling.push("poll");
			return stopPolling.length === 1
				? {
					lines: ["new response"],
					cursor: { turnCount: 2, assistantMessageCount: 2, fileSize: 192 },
				}
				: undefined;
		};
		return subscription;
	};
	let requestRenderCount = 0;
	const component = createLiveOverlay(source).open("root.worker", {
		requestRender() {
			requestRenderCount++;
		},
	});
	try {
		assert.deepEqual(component.getState().activity, ["▸ existing request"]);
		const deadline = Date.now() + 1_500;
		while (stopPolling.length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.equal(stopPolling.length, 1, "the file-backed source is polled on the 250ms interval");
		assert.deepEqual(component.getState().activity, ["▸ existing request", "new response"]);
		assert.equal(requestRenderCount, 1, "incremental backfill requests a render once");

		component.close();
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(stopPolling.length, 1, "close clears the backfill interval");
		assert.equal(source.unsubscribeCount, 1);
	} finally {
		component.close();
	}
});

test("live overlay headline shows current-turn elapsed while the turn is in flight", () => {
	const source = new FakeOverlaySource();
	const overlay = createLiveOverlay(source);
	const component = overlay.open("root.worker", { maxLines: 5, now: () => 10_000 });
	try {
		source.emit("root.worker", { type: "turn_start", ts: 6_000 });
		const rendered = component.render(100).join("\n");
		assert.match(rendered, /turn 1 \(4s\)/);

		source.emit("root.worker", { type: "agent_settled", ts: 9_000 });
		const settled = component.render(100).join("\n");
		assert.doesNotMatch(settled, /turn 1 \(/);
		assert.match(settled, /turn 1/);
	} finally {
		component.close();
	}
});
