import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	stripTerminalSequences,
	type OverlayHandle,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type {
	AssistantMessage,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	contextKindLabel,
	createLiveOverlay,
	resolveModalLayout,
	resolveModalOverlayOptions,
	type LiveOverlayEvent,
	type LiveOverlayListener,
	type LiveOverlayNode,
	type LiveOverlaySubscription,
	type LiveOverlaySource,
} from "../../src/tui/live-overlay.ts";
import { parseSessionMessages } from "../../src/tui/chat-items.ts";

// Unit tests run without the host Pi process that normally initializes theme.
initTheme("dark");

class FakeOverlaySource implements LiveOverlaySource {
	readonly listeners = new Map<LiveOverlaySubscription, { nodeId: string; listener: LiveOverlayListener }>();
	backfill?: LiveOverlaySource["backfill"];
	subscribeCount = 0;
	unsubscribeCount = 0;
	private nextSubscription = 0;
	private readonly nodes = new Map<string, LiveOverlayNode>([
		[
			"root",
			{
				id: "root",
				name: "root",
				role: "orchestrator",
				model: "test/model",
				status: "running",
				parentId: null,
				depth: 0,
				createdAt: 1_000,
				updatedAt: 1_000,
			},
		],
		[
			"root.worker",
			{
				id: "root.worker",
				name: "worker",
				role: "worker",
				model: "test/model",
				status: "running",
				parentId: "root",
				depth: 1,
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
				parentId: "root",
				depth: 1,
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

	/** Replace a node fixture so a test can vary one field (e.g. spawnMode). */
	setNode(node: LiveOverlayNode): void {
		this.nodes.set(node.id, node);
	}

	emit(nodeId: string, event: LiveOverlayEvent): void {
		for (const { nodeId: subscribedNode, listener } of this.listeners.values()) {
			if (subscribedNode === nodeId) listener({ ...event, nodeId });
		}
	}
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 } satisfies UserMessage;
}

function assistantMessage(
	text: string,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		toolCallId?: string;
		toolName?: string;
		thinking?: string;
		args?: Record<string, string>;
	} = {},
): AgentMessage {
	const content: AssistantMessage["content"] = [];
	if (options.thinking) content.push({ type: "thinking", thinking: options.thinking });
	if (text) content.push({ type: "text", text });
	if (options.toolCallId) {
		content.push({
			type: "toolCall",
			id: options.toolCallId,
			name: options.toolName ?? "read",
			arguments: options.args ?? { path: "file.ts" },
		});
	}
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "openai",
		model: "test/model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options.stopReason ?? "stop",
		timestamp: 2,
	} satisfies AssistantMessage;
}

/**
 * A frame-relative click. `x` defaults to 2, not 1: the modal spends column 0 on its
 * `┃` border and a tool block spends column 1 on its `Box` padding, and `Box.handleMouse`
 * rejects a hit on its padding column. Column 2 is the first cell that belongs to the
 * tool row itself — the same geometry the main TUI dispatches.
 */
function mouseEvent(y: number, type: TuiMouseEvent["type"] = "click", x = 2): TuiMouseEvent {
	return {
		type,
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width: 80,
		height: 40,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

function toolResult(
	toolCallId: string,
	text: string,
	options: { toolName?: string; durationMs?: number } = {},
): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: options.toolName ?? "read",
		content: [{ type: "text", text }],
		isError: false,
		...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
		timestamp: 3,
	} satisfies ToolResultMessage;
}

function messageEntry(message: Record<string, unknown>): string {
	return JSON.stringify({ type: "message", message });
}

function sessionWithToolResult(): string {
	return [
		JSON.stringify({ type: "session", id: "sess-test", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
		messageEntry({ role: "user", content: "Review the implementation", timestamp: 1 }),
		messageEntry({
			role: "assistant",
			content: [
				{ type: "text", text: "Checking the source." },
				{ type: "toolCall", id: "tool-call-1", name: "read", arguments: { path: "src/example.ts" } },
			],
			api: "openai-completions",
			provider: "openai",
			model: "test/model",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: 2,
		}),
		messageEntry({
			role: "toolResult",
			toolCallId: "tool-call-1",
			toolName: "read",
			content: [{ type: "text", text: Array.from({ length: 12 }, (_, index) => `result line ${index + 1}`).join("\n") }],
			isError: false,
			timestamp: 3,
		}),
		messageEntry({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "Here is the implementation:\n\n```typescript\nconst answer: number = 42;\n```" },
			],
			api: "openai-completions",
			provider: "openai",
			model: "test/model",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: 4,
		}),
	].join("\n");
}

const cursor = (turnCount: number, assistantMessageCount: number, messageCount: number, fileSize: number) => ({
	turnCount,
	assistantMessageCount,
	messageCount,
	fileSize,
});

const keybindings = {
	matches(data: string, id: string) {
		return id === "app.tools.expand" && matchesKey(data, Key.ctrl("o"));
	},
	getKeys(id: string) {
		return id === "app.tools.expand" ? [Key.ctrl("o")] : [];
	},
} as const;

test("live overlay subscribes only when opened for the requested node and Esc unsubscribes", () => {
	const source = new FakeOverlaySource();
	const overlay = createLiveOverlay(source);
	assert.equal(source.subscribeCount, 0, "creating the controller is inert");

	let doneCount = 0;
	const component = overlay.open("root.worker", { done: () => doneCount++ });
	assert.equal(source.subscribeCount, 1);
	assert.equal(source.listeners.size, 1);
	assert.equal([...source.listeners.values()][0]?.nodeId, "root.worker");
	assert.match(component.render(80).join("\n"), /No session yet\./);
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
	assert.equal(hideCount, 0, "Esc leaves hiding to pi's done(); a second hide would pop the overlay underneath");
	assert.equal(component.getState().open, false);
	component.handleInput?.("\u001b");
	component.dispose();
	assert.equal(source.unsubscribeCount, 1, "close and dispose are idempotent");
	assert.equal(doneCount, 1);
	assert.equal(overlay.getCurrent(), undefined);
});

test("live overlay streams text/tool/settled events into a bounded recent-message view", () => {
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
			type: "tool_call",
			data: { toolName: "read", phase: "tool_execution_start" },
		});
		assert.equal(component.getState().streamingText, "", "production-shaped tool start closes the streamed assistant message");
		const separate = component.getState().activity.length === 2 &&
			component.getState().activity[0] === "hello world" &&
			component.getState().activity[1] === "⚙ read";
		assert.equal(separate, true, "production-shaped tool start keeps the assistant and tool entries separate");
		source.emit("root.worker", {
			type: "tool_call",
			data: { toolName: "read", phase: "tool_execution_end" },
		});
		assert.equal(component.getState().activity.at(-1), "✓ read", "production-shaped tool end gets the completion marker");
		assert.ok(component.getState().itemCount <= 1, "coarse tool facts do not create transcript components");
		source.emit("root.worker", { type: "turn_start" });
		source.emit("root.worker", { type: "agent_settled", ts: 4_000 });

		const state = component.getState();
		assert.equal(state.open, true);
		assert.equal(state.status, "running", "RPC turn settlement does not settle the Legion node");
		assert.equal(state.turn, 1);
		assert.ok(state.activity.length <= 3);
		assert.deepEqual(state.activity, ["✓ read", "↻ turn 1", "✓ agent turn settled"]);
		const rendered = component.render(100).join("\n");
		assert.match(rendered, /● worker · 子/);
		assert.match(rendered, /running/);
		assert.match(state.text, /hello world/);
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

test("live overlay synchronously renders structured backfill before subscribing", () => {
	const source = new FakeOverlaySource();
	const overlay = createLiveOverlay(source);
	const requestedTurns: number[] = [];
	let requestRenderCount = 0;
	const archived = [
		userMessage("archived request"),
		assistantMessage("archived answer", { toolCallId: "archived-tool" }),
		toolResult("archived-tool", "archived output"),
	];
	const component = overlay.open("root.worker", {
		maxBackfillTurns: 2,
		backfill(nodeId, maxBackfillTurns) {
			assert.equal(nodeId, "root.worker");
			assert.equal(source.subscribeCount, 0, "history is loaded before the live event subscription");
			requestedTurns.push(maxBackfillTurns);
			return {
				messages: archived,
				cursor: cursor(1, 1, 3, 128),
			};
		},
		requestRender() {
			requestRenderCount++;
		},
	});
	try {
		assert.deepEqual(requestedTurns, [2]);
		assert.deepEqual(component.getState().activity, ["▸ archived request", "archived answer", "⚙ read"]);
		assert.equal(component.getState().itemCount, 3);
		assert.equal(requestRenderCount, 0, "synchronous backfill is present on first render without scheduling another one");
		assert.equal(source.subscribeCount, 1);
	} finally {
		component.close();
	}
});

test("live overlay polls structured non-RPC backfill and stops polling when closed", async () => {
	const source = new FakeOverlaySource();
	const stopPolling: string[] = [];
	const originalSubscribe = source.subscribe.bind(source);
	const existing = [userMessage("existing request"), assistantMessage("existing response")];
	const appended = [userMessage("existing request"), assistantMessage("existing response"), assistantMessage("new response")];
	source.backfill = () => ({
		messages: existing,
		cursor: cursor(1, 1, 2, 128),
	});
	source.subscribe = (nodeId, listener) => {
		const subscription = originalSubscribe(nodeId, listener);
		subscription.pollBackfill = () => {
			stopPolling.push("poll");
			return stopPolling.length === 1
				? {
					messages: appended,
					cursor: cursor(1, 2, 3, 192),
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
		assert.deepEqual(component.getState().activity, ["▸ existing request", "existing response"]);
		const deadline = Date.now() + 1_500;
		while (stopPolling.length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.equal(stopPolling.length, 1, "the file-backed source is polled on the 250ms interval");
		assert.deepEqual(component.getState().activity, ["▸ existing request", "existing response", "new response"]);
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

test("cursor regression is ignored without advancing or replaying old messages", async () => {
	const source = new FakeOverlaySource();
	const initial = [userMessage("request"), assistantMessage("first answer")];
	const complete = [...initial, assistantMessage("second answer")];
	let polls = 0;
	source.backfill = () => ({ messages: initial, cursor: cursor(1, 1, 2, 128) });
	const originalSubscribe = source.subscribe.bind(source);
	source.subscribe = (nodeId, listener) => {
		const subscription = originalSubscribe(nodeId, listener);
		subscription.pollBackfill = (currentCursor) => {
			polls++;
			assert.equal(currentCursor.messageCount, 2, "a regressed message count cannot move the cursor");
			if (polls === 1) {
				return { messages: [userMessage("request")], cursor: cursor(1, 0, 1, 64) };
			}
			return { messages: complete, cursor: cursor(1, 2, 3, 192) };
		};
		return subscription;
	};
	const component = createLiveOverlay(source).open("root.worker");
	try {
		const deadline = Date.now() + 1_500;
		while (polls < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(polls, 1);
		assert.deepEqual(component.getState().activity, ["▸ request", "first answer"]);
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.ok(polls >= 2);
		assert.deepEqual(component.getState().activity, ["▸ request", "first answer", "second answer"]);
		assert.equal(component.getState().cursor?.messageCount, 3);
	} finally {
		component.close();
	}
});

test("malformed null content parts in user, assistant, and tool results do not crash the viewer", () => {
	const source = new FakeOverlaySource();
	const sessionText = [
		JSON.stringify({ type: "session", id: "sess-null-parts", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
		messageEntry({ role: "user", content: [{ type: "text", text: "Safe user text" }, null], timestamp: 1 }),
		messageEntry({
			role: "assistant",
			content: [null, { type: "text", text: "Safe assistant text" }, { type: "toolCall", id: "null-parts-tool", name: "read", arguments: {} }],
			api: "openai-completions",
			provider: "openai",
			model: "test/model",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: 2,
		}),
		messageEntry({
			role: "toolResult",
			toolCallId: "null-parts-tool",
			toolName: "read",
			content: [null, { type: "text", text: "Safe tool result" }],
			isError: false,
			timestamp: 3,
		}),
	].join("\n");
	source.backfill = () => {
		const messages = parseSessionMessages(sessionText);
		return { messages, cursor: cursor(1, 1, messages.length, 512) };
	};
	const component = createLiveOverlay(source).open("root.worker", {
		terminalRows: 40,
		keybindings: keybindings as never,
	});
	try {
		const collapsed = stripTerminalSequences(component.render(100).join("\n"));
		assert.match(collapsed, /Safe user text/);
		assert.match(collapsed, /Safe assistant text/);
		// D1/parity: the host `read` renderer returns "" from `renderResult` while
		// collapsed (`!expanded && !isError`), so a collapsed block is its call line —
		// exactly what the main TUI draws. The result is revealed by ctrl+o below.
		assert.match(collapsed, /read/);
		assert.doesNotMatch(collapsed, /Safe tool result/);
		component.handleInput?.("\u000f");
		assert.match(stripTerminalSequences(component.getState().text), /Safe tool result/);
		assert.equal(component.getState().itemCount, 3);
	} finally {
		component.close();
	}
});

test("orphan tool results are held pending and backfilled into their later tool call", () => {
	const source = new FakeOverlaySource();
	source.backfill = () => {
		const messages = [
			toolResult("orphan-call", "orphan output arrives first"),
			userMessage("Inspect this"),
			assistantMessage("Reading now", { toolCallId: "orphan-call" }),
		];
		return { messages, cursor: cursor(1, 1, messages.length, 512) };
	};
	const component = createLiveOverlay(source).open("root.worker", {
		terminalRows: 40,
		keybindings: keybindings as never,
	});
	try {
		const collapsed = stripTerminalSequences(component.render(100).join("\n"));
		assert.match(collapsed, /read file\.ts/);
		assert.doesNotMatch(collapsed, /orphan output arrives first/, "collapsed: the call line only");
		component.handleInput?.("\u000f");
		assert.match(
			stripTerminalSequences(component.getState().text),
			/orphan output arrives first/,
			"the pending result was backfilled into the later tool call",
		);
		assert.equal(component.getState().itemCount, 3, "tool result does not add a standalone component");
		assert.equal(component.getState().items.filter((item) => item.kind === "tool").length, 1);
	} finally {
		component.close();
	}
});

test("v1 session headers migrate before their messages render", () => {
	const source = new FakeOverlaySource();
	const v1Session = [
		JSON.stringify({ type: "session", version: 1, id: "sess-v1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
		messageEntry({ role: "user", content: "Legacy user prompt", timestamp: 1 }),
		messageEntry({
			role: "assistant",
			content: [{ type: "text", text: "Legacy assistant answer" }],
			api: "openai-completions",
			provider: "openai",
			model: "test/model",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: 2,
		}),
	].join("\n");
	source.backfill = () => {
		const messages = parseSessionMessages(v1Session);
		return { messages, cursor: cursor(1, 1, messages.length, 512) };
	};
	const component = createLiveOverlay(source).open("root.worker", { terminalRows: 40 });
	try {
		const rendered = stripTerminalSequences(component.render(100).join("\n"));
		assert.match(rendered, /Legacy user prompt/);
		assert.match(rendered, /Legacy assistant answer/);
		assert.equal(component.getState().itemCount, 2);
	} finally {
		component.close();
	}
});

test("a viewer dispatch error during a disk poll is contained to that polling tick", async () => {
	const source = new FakeOverlaySource();
	const initial = [userMessage("Inspect"), assistantMessage("Checking")];
	const appended = [
		...initial,
		assistantMessage("", { toolCallId: "poll-tool" }),
		toolResult("poll-tool", Array.from({ length: 14 }, (_, index) => `poll result ${index + 1}`).join("\n")),
	];
	let polls = 0;
	source.backfill = () => ({ messages: initial, cursor: cursor(1, 1, 2, 128) });
	const originalSubscribe = source.subscribe.bind(source);
	source.subscribe = (nodeId, listener) => {
		const subscription = originalSubscribe(nodeId, listener);
		subscription.pollBackfill = () => {
			polls++;
			return polls === 1 ? { messages: appended, cursor: cursor(1, 2, 4, 256) } : undefined;
		};
		return subscription;
	};
	let throwOnFirstKeysRead = true;
	const throwingKeybindings = {
		...keybindings,
		getKeys(id: string) {
			if (throwOnFirstKeysRead && id === "app.tools.expand") {
				throwOnFirstKeysRead = false;
				throw new Error("transient transcript render failure");
			}
			return [Key.ctrl("o")];
		},
	};
	const component = createLiveOverlay(source).open("root.worker", {
		terminalRows: 40,
		keybindings: throwingKeybindings as never,
	});
	try {
		await new Promise((resolve) => setTimeout(resolve, 600));
		assert.ok(polls >= 2, "the interval callback survives a render/dispatch exception");
		assert.equal(component.getState().open, true);
	} finally {
		component.close();
	}
});

test("tool mouse events are mapped through the viewer header and scroll offset into the tool wrapper", () => {
	const source = new FakeOverlaySource();
	source.backfill = () => {
		const messages = parseSessionMessages(sessionWithToolResult());
		return { messages, cursor: cursor(1, 2, messages.length, 1_024) };
	};
	const component = createLiveOverlay(source).open("root.worker", { terminalRows: 40 });
	try {
		const before = component.render(80);
		const layout = resolveModalLayout(40, 80);
		// The hit test runs against the tool row itself, not the modal's `┃` border column
		// (x=0) nor the block's `Box` padding column (x=1) — `Box.handleMouse` rejects both.
		const visibleToolLine = before.findIndex((line) => stripTerminalSequences(line).includes("read"));
		assert.ok(visibleToolLine >= layout.bodyStartRow, "tool component appears in the modal body");
		const result = component.handleMouse?.(mouseEvent(visibleToolLine));
		assert.equal(result?.handled, true, "mouse hit reaches the tool component/wrapper");
	} finally {
		component.close();
	}
});

test("session messages render with Pi user background, markdown highlighting, and tool results", () => {
	const source = new FakeOverlaySource();
	source.backfill = () => {
		const messages = parseSessionMessages(sessionWithToolResult());
		return { messages, cursor: cursor(1, 2, messages.length, 1_024) };
	};
	const component = createLiveOverlay(source).open("root.worker", {
		terminalRows: 40,
		settings: { hideThinkingBlock: true },
		keybindings: keybindings as never,
	});
	try {
		const rendered = component.render(100).join("\n");
		assert.match(stripTerminalSequences(rendered), /Review the implementation/);
		assert.match(stripTerminalSequences(rendered), /read src\/example\.ts/);
		assert.match(stripTerminalSequences(rendered), /Thinking\.\.\./);
		assert.doesNotMatch(stripTerminalSequences(rendered), /private reasoning/);
		// D1/parity: collapsed shows the call line only (host `read` renderResult returns ""
		// unless expanded or an error), so the result text appears after ctrl+o.
		assert.doesNotMatch(stripTerminalSequences(rendered), /result line 1/);
		component.handleInput?.("\u000f");
		assert.match(
			stripTerminalSequences(component.getState().text),
			/result line 1/,
			"ctrl+o reveals the tool result under the host renderer",
		);
		const userLineIndex = stripTerminalSequences(rendered).split("\n").findIndex((line) => line.includes("Review the implementation"));
		assert.ok(userLineIndex >= 0, "user message line is present");
		assert.match(rendered.split("\n")[userLineIndex] ?? "", /\u001b\[[0-9;]*48;/, "user message line carries the Pi user-block background ANSI");
		const codeLineIndex = stripTerminalSequences(rendered).split("\n").findIndex((line) => line.includes("const answer"));
		assert.ok(codeLineIndex >= 0 && rendered.split("\n")[codeLineIndex]?.includes("\u001b["), "the fenced code line itself is syntax-highlighted with ANSI colors");
		assert.equal(component.getState().itemCount, 4, "tool result updates its tool component instead of adding a component");
	} finally {
		component.close();
	}
});

test("ctrl+o expands tools, pgdn scrolls, and Esc closes the viewer", () => {
	const source = new FakeOverlaySource();
	source.backfill = () => {
		const messages = parseSessionMessages(sessionWithToolResult());
		return { messages, cursor: cursor(1, 2, messages.length, 1_024) };
	};
	const component = createLiveOverlay(source).open("root.worker", {
		terminalRows: 4,
		keybindings: keybindings as never,
	});
	try {
		const collapsed = component.getState().text;
		// R4 + host parity: a collapsed read block is its call line only, so the 10-line
		// truncation notice no longer fires for it (the old undefined-toolDefinition
		// fallback dumped the whole output, which is what this assertion used to see).
		assert.match(collapsed, /read src\/example\.ts/);
		assert.doesNotMatch(collapsed, /more lines/);
		assert.doesNotMatch(collapsed, /result line 12/);
		component.handleInput?.("\u000f");
		const expanded = component.getState().text;
		assert.notEqual(expanded, collapsed);
		assert.match(expanded, /result line 1/);
		assert.match(expanded, /result line 12/);

		component.handleInput?.("g");
		assert.equal(component.getState().scrollTop, 0);
		component.handleInput?.("j");
		assert.equal(component.getState().scrollTop, 1, "j scrolls down one line");
		component.handleInput?.("k");
		assert.equal(component.getState().scrollTop, 0, "k scrolls up one line");
		component.handleInput?.("G");
		const pageSize = resolveModalLayout(4, 80).bodyRows;
		const maxScrollTop = Math.max(0, expanded.split("\n").length - pageSize);
		assert.equal(component.getState().scrollTop, maxScrollTop, "G moves to the transcript end");
		component.handleInput?.("k");
		assert.equal(component.getState().scrollTop, Math.max(0, maxScrollTop - 1));
		component.handleInput?.("j");
		assert.equal(component.getState().scrollTop, maxScrollTop);
		component.handleInput?.("g");
		assert.equal(component.getState().scrollTop, 0);
		component.handleInput?.("\u001b[6~");
		assert.ok(component.getState().scrollTop > 0, "PageDown moves the self-managed transcript viewport");
		component.handleInput?.("\u001b");
		assert.equal(component.getState().open, false);
		assert.equal(source.unsubscribeCount, 1);
	} finally {
		component.close();
	}
});

/**
 * R4/D20: the 10-line collapsed cap needs a POSITIVE assertion. The `read` fixtures can no longer
 * reach it — the host renderer's collapsed `renderResult` is empty, so such a block is one call
 * row — which is why deleting `TOOL_COLLAPSED_PREVIEW_LINES` used to keep every overlay test green.
 * An unknown tool name (`legion_output`) keeps the host's generic block, whose text is long enough
 * to be capped here, so this test goes red the moment the cap is dropped.
 */
test("a collapsed generic tool block is capped at 10 lines until ctrl+o expands it", () => {
	const source = new FakeOverlaySource();
	const output = Array.from({ length: 12 }, (_, index) => `legacy output ${index + 1}`);
	source.backfill = () => {
		const messages: AgentMessage[] = [
			userMessage("read the artifact"),
			assistantMessage("", {
				toolCallId: "legion-output-1",
				toolName: "legion_output",
				args: { id: "artifact-1" },
			}),
			toolResult("legion-output-1", output.join("\n"), { toolName: "legion_output" }),
		];
		return { messages, cursor: cursor(1, 1, messages.length, 512) };
	};
	const component = createLiveOverlay(source).open("root.worker", {
		terminalRows: 40,
		keybindings: keybindings as never,
	});
	try {
		const collapsed = component.getState().text;
		assert.match(collapsed, /legacy output 1\b/, "the head of the output is visible while collapsed");
		assert.match(collapsed, /\d+ more lines/, "R4: the capped block says how much is hidden");
		assert.doesNotMatch(collapsed, /legacy output 12/, "the tail is behind the cap");

		component.handleInput?.("\u000f");
		const expanded = component.getState().text;
		assert.match(expanded, /legacy output 12/, "ctrl+o reveals the whole output");
		assert.equal(
			expanded.split("legacy output").length - 1,
			output.length,
			"every line of the 12-line output is rendered once expanded",
		);
	} finally {
		component.close();
	}
});

test("finalize before disk backfill does not double-render the settled message", async () => {
	const source = new FakeOverlaySource();
	const diskMessages = [assistantMessage("answer one")];
	let polls = 0;
	source.backfill = () => ({ messages: [], cursor: cursor(0, 0, 0, 128) });
	const originalSubscribe = source.subscribe.bind(source);
	source.subscribe = (nodeId, listener) => {
		const subscription = originalSubscribe(nodeId, listener);
		subscription.pollBackfill = () => {
			polls++;
			return polls === 1
				? { messages: diskMessages, cursor: cursor(1, 1, 1, 192) }
				: undefined;
		};
		return subscription;
	};
	const component = createLiveOverlay(source).open("root.worker", { terminalRows: 40 });
	try {
		source.emit("root.worker", { type: "text_delta", delta: "answer one" });
		source.emit("root.worker", { type: "agent_settled" });
		const pollDeadline = Date.now() + 1_500;
		while (polls === 0 && Date.now() < pollDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(polls, 1, "the incremental session-file batch is polled");

		const state = component.getState();
		const rendered = stripTerminalSequences(state.text);
		assert.equal(rendered.split("answer one").length - 1, 1);
		assert.equal(state.items.filter((item) => item.kind === "assistant").length, 1);
	} finally {
		component.close();
	}
});

test("finalized dedup preserves toolCall blocks of the landing message", async () => {
	const source = new FakeOverlaySource();
	const diskMessages = [
		assistantMessage("let me check", { toolCallId: "read-call-1", toolName: "read" }),
		toolResult("read-call-1", "file output"),
	];
	let polls = 0;
	source.backfill = () => ({ messages: [], cursor: cursor(0, 0, 0, 128) });
	const originalSubscribe = source.subscribe.bind(source);
	source.subscribe = (nodeId, listener) => {
		const subscription = originalSubscribe(nodeId, listener);
		subscription.pollBackfill = () => {
			polls++;
			return polls === 1
				? { messages: diskMessages, cursor: cursor(1, 1, 2, 192) }
				: undefined;
		};
		return subscription;
	};
	const component = createLiveOverlay(source).open("root.worker", { terminalRows: 40 });
	try {
		source.emit("root.worker", { type: "text_delta", delta: "let me check" });
		source.emit("root.worker", {
			type: "tool_call",
			data: { toolName: "read", phase: "tool_execution_start" },
		});
		const pollDeadline = Date.now() + 1_500;
		while (polls === 0 && Date.now() < pollDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(polls, 1, "the incremental session-file batch is polled");

		const state = component.getState();
		const rendered = stripTerminalSequences(state.text);
		assert.equal(rendered.split("let me check").length - 1, 1);
		assert.equal(state.items.filter((item) => item.kind === "tool").length, 1);
		assert.match(rendered, /read/);
	} finally {
		component.close();
	}
});

test("a fresh streaming cycle clears the finalized record", async () => {
	const source = new FakeOverlaySource();
	const diskMessages = [assistantMessage("alpha and more")];
	let polls = 0;
	source.backfill = () => ({ messages: [], cursor: cursor(0, 0, 0, 128) });
	const originalSubscribe = source.subscribe.bind(source);
	source.subscribe = (nodeId, listener) => {
		const subscription = originalSubscribe(nodeId, listener);
		subscription.pollBackfill = () => {
			polls++;
			return polls === 1
				? { messages: diskMessages, cursor: cursor(1, 1, 1, 192) }
				: undefined;
		};
		return subscription;
	};
	const component = createLiveOverlay(source).open("root.worker", { terminalRows: 40 });
	try {
		source.emit("root.worker", { type: "text_delta", delta: "alpha" });
		source.emit("root.worker", { type: "agent_settled" });
		source.emit("root.worker", { type: "text_delta", delta: "beta" });
		const pollDeadline = Date.now() + 1_500;
		while (polls === 0 && Date.now() < pollDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(polls, 1, "the incremental session-file batch is polled");

		const rendered = stripTerminalSequences(component.getState().text);
		assert.match(rendered, /alpha and more/);
		assert.equal(rendered.split("alpha and more").length - 1, 1);
	} finally {
		component.close();
	}
});

test("disk assistant message supersedes the streaming component", async () => {
	const source = new FakeOverlaySource();
	const diskMessages = [assistantMessage("partial + more")];
	let polls = 0;
	source.backfill = () => ({ messages: [], cursor: cursor(0, 0, 0, 128) });
	const originalSubscribe = source.subscribe.bind(source);
	source.subscribe = (nodeId, listener) => {
		const subscription = originalSubscribe(nodeId, listener);
		subscription.pollBackfill = () => {
			polls++;
			return polls === 1
				? { messages: diskMessages, cursor: cursor(1, 1, 1, 192) }
				: undefined;
		};
		return subscription;
	};
	const component = createLiveOverlay(source).open("root.worker", { terminalRows: 40 });
	try {
		source.emit("root.worker", { type: "text_delta", delta: "partial" });
		assert.equal(component.getState().streamingText, "partial");
		const pollDeadline = Date.now() + 1_500;
		while (polls === 0 && Date.now() < pollDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(polls, 1, "the incremental session-file batch is polled");

		const state = component.getState();
		assert.equal(state.items.filter((item) => item.kind === "assistant").length, 1);
		assert.match(stripTerminalSequences(state.text), /partial \+ more/);
		assert.doesNotMatch(stripTerminalSequences(state.text), /partialpartial/);
		assert.equal(state.streamingText, "");
	} finally {
		component.close();
	}
});

test("streaming ahead of disk keeps the remaining tail", async () => {
	const source = new FakeOverlaySource();
	const diskMessages = [assistantMessage("full")];
	let polls = 0;
	source.backfill = () => ({ messages: [], cursor: cursor(0, 0, 0, 128) });
	const originalSubscribe = source.subscribe.bind(source);
	source.subscribe = (nodeId, listener) => {
		const subscription = originalSubscribe(nodeId, listener);
		subscription.pollBackfill = () => {
			polls++;
			return polls === 1
				? { messages: diskMessages, cursor: cursor(1, 1, 1, 192) }
				: undefined;
		};
		return subscription;
	};
	const component = createLiveOverlay(source).open("root.worker", { terminalRows: 40 });
	try {
		source.emit("root.worker", { type: "text_delta", delta: "full tail ahead" });
		const pollDeadline = Date.now() + 1_500;
		while (polls === 0 && Date.now() < pollDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(polls, 1, "the incremental session-file batch is polled");

		const state = component.getState();
		assert.match(stripTerminalSequences(state.text), /full/);
		assert.match(stripTerminalSequences(state.text), /tail ahead/);
		assert.equal(state.streamingText, " tail ahead");
		assert.equal(state.items.filter((item) => item.kind === "assistant").length, 2);
	} finally {
		component.close();
	}
});

test("an unrelated disk assistant preserves the streaming draft", async () => {
	const source = new FakeOverlaySource();
	const diskMessages = [assistantMessage("different final text")];
	let polls = 0;
	source.backfill = () => ({ messages: [], cursor: cursor(0, 0, 0, 128) });
	const originalSubscribe = source.subscribe.bind(source);
	source.subscribe = (nodeId, listener) => {
		const subscription = originalSubscribe(nodeId, listener);
		subscription.pollBackfill = () => {
			polls++;
			return polls === 1
				? { messages: diskMessages, cursor: cursor(1, 1, 1, 192) }
				: undefined;
		};
		return subscription;
	};
	const component = createLiveOverlay(source).open("root.worker", { terminalRows: 40 });
	try {
		source.emit("root.worker", { type: "text_delta", delta: "unrelated draft" });
		const pollDeadline = Date.now() + 1_500;
		while (polls === 0 && Date.now() < pollDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(polls, 1, "the incremental session-file batch is polled");

		const state = component.getState();
		const rendered = stripTerminalSequences(state.text);
		assert.match(rendered, /different final text/);
		assert.match(rendered, /unrelated draft/);
		assert.equal(state.streamingText, "unrelated draft");
	} finally {
		component.close();
	}
});

test("disk backfill containing an opened-midstream tail retracts its duplicate", async () => {
	const source = new FakeOverlaySource();
	const diskMessages = [assistantMessage("The answer is 42")];
	let polls = 0;
	source.backfill = () => ({ messages: [], cursor: cursor(0, 0, 0, 128) });
	const originalSubscribe = source.subscribe.bind(source);
	source.subscribe = (nodeId, listener) => {
		const subscription = originalSubscribe(nodeId, listener);
		subscription.pollBackfill = () => {
			polls++;
			return polls === 1
				? { messages: diskMessages, cursor: cursor(1, 1, 1, 192) }
				: undefined;
		};
		return subscription;
	};
	const component = createLiveOverlay(source).open("root.worker", { terminalRows: 40 });
	try {
		source.emit("root.worker", { type: "text_delta", delta: "s 42" });
		const pollDeadline = Date.now() + 1_500;
		while (polls === 0 && Date.now() < pollDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(polls, 1, "the incremental session-file batch is polled");

		const state = component.getState();
		const rendered = stripTerminalSequences(state.text);
		assert.equal(rendered.split("The answer is 42").length - 1, 1);
		assert.equal(rendered.split("s 42").length - 1, 1, "the tail remains only inside the complete answer");
		assert.equal(state.items.filter((item) => item.kind === "assistant").length, 1);
		assert.equal(state.streamingText, "");
	} finally {
		component.close();
	}
});

test("disk backfill containing clamped streaming text does not repeat its last line", async () => {
	const source = new FakeOverlaySource();
	const lines = ["First line", "Second line", "Third line", "Fourth line", "Fifth line"];
	const diskMessages = [assistantMessage(lines.join("\n"))];
	let polls = 0;
	source.backfill = () => ({ messages: [], cursor: cursor(0, 0, 0, 128) });
	const originalSubscribe = source.subscribe.bind(source);
	source.subscribe = (nodeId, listener) => {
		const subscription = originalSubscribe(nodeId, listener);
		subscription.pollBackfill = () => {
			polls++;
			return polls === 1
				? { messages: diskMessages, cursor: cursor(1, 1, 1, 192) }
				: undefined;
		};
		return subscription;
	};
	const component = createLiveOverlay(source).open("root.worker", { maxLines: 2, terminalRows: 40 });
	try {
		for (const [index, line] of lines.entries()) {
			source.emit("root.worker", {
				type: "text_delta",
				delta: `${index === 0 ? "" : "\n"}${line}`,
			});
		}
		assert.equal(component.getState().streamingText, "Fourth line\nFifth line");

		const pollDeadline = Date.now() + 1_500;
		while (polls === 0 && Date.now() < pollDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(polls, 1, "the incremental session-file batch is polled");

		const state = component.getState();
		const rendered = stripTerminalSequences(state.text);
		assert.equal(rendered.split("Fifth line").length - 1, 1);
		assert.equal(state.streamingText, "");
	} finally {
		component.close();
	}
});

/**
 * D4/R1: reasoning streams into the SAME assistant item as text, and the settled message that lands
 * afterwards must not paint the same reasoning a second time. The settled copy arrives AFTER
 * `agent_settled` here on purpose: that is the REV-4 shape, where the streaming item was already
 * finalized (and stays mounted) and only the disk copy can still be deduped.
 */
test("streamed thinking is not painted twice once the settled message lands", async () => {
	const source = new FakeOverlaySource();
	const diskMessages = [assistantMessage("final answer", { thinking: "weigh options" })];
	let polls = 0;
	source.backfill = () => ({ messages: [], cursor: cursor(0, 0, 0, 128) });
	const originalSubscribe = source.subscribe.bind(source);
	source.subscribe = (nodeId, listener) => {
		const subscription = originalSubscribe(nodeId, listener);
		subscription.pollBackfill = () => {
			polls++;
			return polls === 1
				? { messages: diskMessages, cursor: cursor(1, 1, 1, 192) }
				: undefined;
		};
		return subscription;
	};
	const component = createLiveOverlay(source).open("root.worker", { terminalRows: 40 });
	try {
		source.emit("root.worker", { type: "thinking_delta", data: { delta: "weigh " } });
		source.emit("root.worker", { type: "thinking_delta", data: { delta: "options" } });
		assert.match(
			stripTerminalSequences(component.getState().text),
			/weigh options/,
			"D4: reasoning renders while it streams, not only at message_end",
		);
		assert.deepEqual(
			component.getState().activity,
			[],
			"a thinking delta is a detail, not a `· thinking_delta` activity row",
		);

		source.emit("root.worker", { type: "text_delta", delta: "final answer" });
		source.emit("root.worker", { type: "agent_settled" });

		const pollDeadline = Date.now() + 1_500;
		while (polls === 0 && Date.now() < pollDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(polls, 1, "the incremental session-file batch is polled");

		const state = component.getState();
		const rendered = stripTerminalSequences(state.text);
		assert.equal(rendered.split("weigh options").length - 1, 1, "the same reasoning must not be painted twice");
		assert.equal(rendered.split("final answer").length - 1, 1, "the text half is deduped as before");
		assert.equal(state.items.filter((item) => item.kind === "assistant").length, 1);
	} finally {
		component.close();
	}
});

/**
 * D5 under the display clamp (review finding 6): `finishStreaming()` has to publish the
 * UNCLAMPED reasoning as the committed record. Reading the clamped `streamingThinking` mirror
 * first reduces `finalizedAssistantThinking` to a suffix of the disk copy, so
 * `finalizedThinking.includes(diskThinking)` can never match, the landed message is not stripped
 * and the whole settled run is painted a second time. 130 lines is one line past the 120-line
 * default window, which is exactly where the mirror starts losing its head.
 */
test("settled thinking longer than the display clamp is not painted twice", async () => {
	const source = new FakeOverlaySource();
	const lines = Array.from({ length: 130 }, (_, index) => `thought line ${index + 1}`);
	// Blank-line-separated paragraphs: each line then renders on its own row, so the sentinel can
	// never be split by markdown wrapping and its occurrence count is meaningful.
	const diskMessages = [assistantMessage("long answer", { thinking: lines.join("\n\n") })];
	let polls = 0;
	source.backfill = () => ({ messages: [], cursor: cursor(0, 0, 0, 128) });
	const originalSubscribe = source.subscribe.bind(source);
	source.subscribe = (nodeId, listener) => {
		const subscription = originalSubscribe(nodeId, listener);
		subscription.pollBackfill = () => {
			polls++;
			return polls === 1
				? { messages: diskMessages, cursor: cursor(1, 1, 1, 192) }
				: undefined;
		};
		return subscription;
	};
	const component = createLiveOverlay(source).open("root.worker", { terminalRows: 40 });
	try {
		for (const line of lines) {
			source.emit("root.worker", { type: "thinking_delta", data: { delta: `${line}\n\n` } });
		}
		source.emit("root.worker", { type: "text_delta", delta: "long answer" });
		source.emit("root.worker", { type: "agent_settled" });

		const pollDeadline = Date.now() + 1_500;
		while (polls === 0 && Date.now() < pollDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(polls, 1, "the incremental session-file batch is polled");

		const state = component.getState();
		const rendered = stripTerminalSequences(state.text);
		assert.equal(
			rendered.split("thought line 130").length - 1,
			1,
			"reasoning past the clamp window must not survive in the landed message as a second copy",
		);
		assert.equal(rendered.split("long answer").length - 1, 1, "the text half is deduped as before");
		assert.equal(state.items.filter((item) => item.kind === "assistant").length, 1);
	} finally {
		component.close();
	}
});

/**
 * D5 follow-up (same defect class as the thinking half): the committed text must be the UNCLAMPED
 * accumulation. With the clamped mirror as the dedup key, a settled answer longer than the viewer
 * window never matched by containment and the landed message painted the last lines a second time.
 */
test("settled text longer than the display clamp is not painted twice", async () => {
	const source = new FakeOverlaySource();
	const lines = Array.from({ length: 130 }, (_, index) => `answer line ${index + 1}`);
	const diskMessages = [assistantMessage(lines.join("\n\n"))];
	let polls = 0;
	source.backfill = () => ({ messages: [], cursor: cursor(0, 0, 0, 128) });
	const originalSubscribe = source.subscribe.bind(source);
	source.subscribe = (nodeId, listener) => {
		const subscription = originalSubscribe(nodeId, listener);
		subscription.pollBackfill = () => {
			polls++;
			return polls === 1
				? { messages: diskMessages, cursor: cursor(1, 1, 1, 192) }
				: undefined;
		};
		return subscription;
	};
	const component = createLiveOverlay(source).open("root.worker", { terminalRows: 40 });
	try {
		for (const line of lines) {
			source.emit("root.worker", { type: "text_delta", delta: `${line}\n\n` });
		}
		source.emit("root.worker", { type: "agent_settled" });

		const pollDeadline = Date.now() + 1_500;
		while (polls === 0 && Date.now() < pollDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(polls, 1, "the incremental session-file batch is polled");

		const state = component.getState();
		const rendered = stripTerminalSequences(state.text);
		assert.equal(
			rendered.split("answer line 130").length - 1,
			1,
			"text past the clamp window must not survive in the landed message as a second copy",
		);
		assert.equal(state.items.filter((item) => item.kind === "assistant").length, 1);
	} finally {
		component.close();
	}
});

/**
 * D5, other half: thinking and text are judged separately. Reasoning that ran ahead of the disk
 * snapshot keeps its uncovered tail in the streaming item instead of being thrown away with the
 * retract, and the covered part is still painted once (by the landed message).
 */
test("streaming reasoning ahead of the disk snapshot keeps its uncovered tail", async () => {
	const source = new FakeOverlaySource();
	const diskMessages = [assistantMessage("answer", { thinking: "the first thought" })];
	let polls = 0;
	source.backfill = () => ({ messages: [], cursor: cursor(0, 0, 0, 128) });
	const originalSubscribe = source.subscribe.bind(source);
	source.subscribe = (nodeId, listener) => {
		const subscription = originalSubscribe(nodeId, listener);
		subscription.pollBackfill = () => {
			polls++;
			return polls === 1
				? { messages: diskMessages, cursor: cursor(1, 1, 1, 192) }
				: undefined;
		};
		return subscription;
	};
	const component = createLiveOverlay(source).open("root.worker", { terminalRows: 40 });
	try {
		source.emit("root.worker", { type: "thinking_delta", data: { delta: "the first thought" } });
		source.emit("root.worker", { type: "thinking_delta", data: { delta: " and the second" } });

		const pollDeadline = Date.now() + 1_500;
		while (polls === 0 && Date.now() < pollDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(polls, 1, "the incremental session-file batch is polled");

		const state = component.getState();
		const rendered = stripTerminalSequences(state.text);
		assert.equal(rendered.split("the first thought").length - 1, 1, "the covered prefix is painted once");
		assert.equal(
			rendered.split("and the second").length - 1,
			1,
			"the reasoning the snapshot did not cover survives in the streaming item",
		);
		assert.equal(state.items.filter((item) => item.kind === "assistant").length, 2);
	} finally {
		component.close();
	}
});

/**
 * D2: once a tool block has its recorded `durationMs`, the host renderer prints its timing line —
 * the whole point of handing `ToolExecutionComponent` the real tool definition (D1). R2: the wording
 * belongs to the host, so the assertion only pins `Took` + a number.
 */
test("a finished tool block renders its recorded duration under the host renderer", () => {
	const source = new FakeOverlaySource();
	source.backfill = () => {
		const messages: AgentMessage[] = [
			userMessage("run the check"),
			assistantMessage("running the check", {
				toolCallId: "bash-call-1",
				toolName: "bash",
				args: { command: "echo hi" },
			}),
			toolResult("bash-call-1", "hi", { toolName: "bash", durationMs: 27_000 }),
		];
		return { messages, cursor: cursor(1, 1, messages.length, 512) };
	};
	const component = createLiveOverlay(source).open("root.worker", { terminalRows: 40 });
	try {
		const text = stripTerminalSequences(component.getState().text);
		assert.match(text, /\$ echo hi/, "the shell renderer drew the call row");
		assert.match(text, /Took[^\n]*\d/, "the final result row shows its recorded duration, like the main TUI");
	} finally {
		component.close();
	}
});

/**
 * D6: `tool_delta` carries the in-flight arguments for the block named by `toolCallId`. The
 * explicit branch must (a) repaint the block, and (b) not fall through to the `· <eventType>`
 * activity fallback — one argument delta per token would spam that log.
 */
test("tool_delta repaints a live tool block without adding an activity row", () => {
	const source = new FakeOverlaySource();
	source.backfill = () => ({
		messages: [
			userMessage("run it"),
			assistantMessage("", {
				toolCallId: "live-call",
				toolName: "bash",
				args: { command: "sleep 1" },
			}),
		],
		cursor: cursor(1, 1, 2, 256),
	});
	const component = createLiveOverlay(source).open("root.worker", { terminalRows: 40 });
	try {
		assert.match(stripTerminalSequences(component.getState().text), /\$ sleep 1/);
		const activityBefore = component.getState().activity;

		source.emit("root.worker", {
			type: "tool_delta",
			data: { toolCallId: "live-call", toolName: "bash", args: { command: "sleep 2" } },
		});
		assert.match(
			stripTerminalSequences(component.getState().text),
			/\$ sleep 2/,
			"the tool block re-rendered with the streamed arguments",
		);
		assert.deepEqual(component.getState().activity, activityBefore, "an argument delta is not an activity row");
	} finally {
		component.close();
	}
});

/**
 * D8/parity: a tool row must still toggle open on click. Under the real host renderers the hit
 * travels modal frame → transcript → our collapsed-line wrapper → `ToolExecutionComponent` → `Box`
 * → the `MouseRegion` the renderer wrapped its call row in, so it also proves the wrapper forwards
 * the event (a wrapper that swallowed `handleMouse` would leave the row dead).
 */
test("clicking a tool row expands and collapses it through the host mouse region", () => {
	const source = new FakeOverlaySource();
	source.backfill = () => {
		const messages = parseSessionMessages(sessionWithToolResult());
		return { messages, cursor: cursor(1, 2, messages.length, 1_024) };
	};
	const component = createLiveOverlay(source).open("root.worker", { terminalRows: 40 });
	try {
		const toolRow = (): number =>
			component.render(80).findIndex((line) => stripTerminalSequences(line).includes("read src/example.ts"));
		assert.ok(toolRow() >= 0, "the read call row is on screen");
		assert.doesNotMatch(stripTerminalSequences(component.getState().text), /result line 1/);

		assert.equal(component.handleMouse?.(mouseEvent(toolRow()))?.handled, true, "the click lands on the tool row");
		assert.match(
			stripTerminalSequences(component.getState().text),
			/result line 1/,
			"a click on the row expands the block, exactly like the main TUI",
		);

		assert.equal(component.handleMouse?.(mouseEvent(toolRow()))?.handled, true);
		assert.doesNotMatch(
			stripTerminalSequences(component.getState().text),
			/result line 1/,
			"a second click collapses it again (the same MouseRegion toggles)",
		);
	} finally {
		component.close();
	}
});

test("live overlay: x opens an in-overlay y/N stop prompt; y calls onStop, other keys cancel", () => {
	const source = new FakeOverlaySource();
	const stopped: string[] = [];
	const component = createLiveOverlay(source).open("root.worker", { maxLines: 5, now: () => 10_000, onStop: (id) => stopped.push(id) });
	try {
		component.handleInput?.("x");
		assert.match(stripTerminalSequences(component.render(120).join("\n")), /Stop .*\? .*y stop/);
		component.handleInput?.("n");
		assert.doesNotMatch(stripTerminalSequences(component.render(120).join("\n")), /y stop/);
		assert.deepEqual(stopped, []);
		component.handleInput?.("x");
		component.handleInput?.("y");
		assert.deepEqual(stopped, ["root.worker"]);
	} finally {
		component.close();
	}
});

test("live overlay close: with pi's done() it does not also hide the handle (would pop the /legion view underneath)", () => {
	const source = new FakeOverlaySource();
	let hides = 0;
	let dones = 0;
	const component = createLiveOverlay(source).open("root.worker", { maxLines: 5, now: () => 10_000, done: () => { dones++; } });
	component.attachOverlayHandle({ hide: () => { hides++; } } as never);
	component.handleInput?.("\x1b");
	assert.equal(dones, 1);
	assert.equal(hides, 0);
	// Without a done callback (direct callers) the handle is still hidden.
	const bare = createLiveOverlay(source).open("root.worker", { maxLines: 5, now: () => 10_000 });
	bare.attachOverlayHandle({ hide: () => { hides++; } } as never);
	bare.close();
	assert.equal(hides, 1);
});


test("contextKindLabel marks root as 主 and children as 子", () => {
	assert.equal(contextKindLabel({ id: "root", name: "root", role: "orchestrator", model: null, status: "running", parentId: null, depth: 0, createdAt: 0, updatedAt: 0 }, "root"), "主");
	assert.equal(contextKindLabel({ id: "root.worker", name: "worker", role: "worker", model: null, status: "running", parentId: "root", depth: 1, createdAt: 0, updatedAt: 0 }, "root.worker"), "子");
	assert.equal(contextKindLabel(undefined, "root.worker"), "子");
	assert.equal(contextKindLabel(undefined, "root"), "主");
});

test("live overlay paints a floating modal: title with 主/子, Esc close; Esc does not stop", () => {
	const source = new FakeOverlaySource();
	const stopped: string[] = [];
	const component = createLiveOverlay(source).open("root.worker", {
		terminalRows: 24,
		now: () => 5_000,
		onStop: (id) => stopped.push(id),
	});
	try {
		const rendered = component.render(80);
		// #193: the component paints the frame rect only. Painting a full-terminal
		// mask is impossible to make transparent — pi-tui drops every base cell in
		// the overlay rectangle — so the surrounding screen is left to the host.
		assert.equal(rendered.length, resolveModalLayout(24, 80).frameRows, "modal renders the frame rect only");
		const plain = rendered.map((line) => stripTerminalSequences(line));
		assert.match(plain.join("\n"), /● worker · 子/);
		assert.match(plain.join("\n"), /Esc/);
		assert.match(plain.join("\n"), /┏|┃|┗/);
		assert.ok(plain.some((line) => line.includes("┃")), "vertical modal borders present");
		assert.ok(
			plain.every((line) => line.startsWith("┏") || line.startsWith("┃") || line.startsWith("┗")),
			"every painted row is frame chrome — no mask cells of its own",
		);
		const layout = resolveModalLayout(24, 80);
		// Meta band sits below the body (role / model / turn / elapsed / status).
		assert.ok(layout.metaRow !== null && layout.showMeta);
		assert.match(plain[layout.metaRow!] ?? "", /worker · test\/model · turn 0 · 4s · running/);
		assert.ok(layout.metaRow! > layout.bodyStartRow, "meta is below the message body");
		component.handleInput?.("\u001b");
		assert.equal(component.getState().open, false);
		assert.equal(stopped.length, 0, "Esc closes the modal only — does not call onStop/retire");
	} finally {
		component.dispose();
	}
});

/**
 * Render the modal for a node and return the footer (meta) band, which is the
 * only place the arbitrated spawnMode is allowed to surface (#209/D5).
 */
function metaBandFor(node: LiveOverlayNode): string {
	const source = new FakeOverlaySource();
	source.setNode(node);
	const component = createLiveOverlay(source).open(node.id, {
		terminalRows: 24,
		now: () => 5_000,
	});
	try {
		const layout = resolveModalLayout(24, 80);
		assert.ok(layout.metaRow !== null && layout.showMeta, "the meta band is visible at 24x80");
		const lines = component.render(80).map((line) => stripTerminalSequences(line));
		return lines[layout.metaRow!] ?? "";
	} finally {
		component.dispose();
	}
}

test("live overlay meta band shows the arbitrated spawn mode when known (#209/D5)", () => {
	const base = {
		id: "root.worker",
		name: "worker",
		role: "worker",
		model: "test/model",
		status: "running" as const,
		parentId: "root",
		depth: 1,
		createdAt: 1_000,
		updatedAt: 1_000,
	};
	assert.match(metaBandFor({ ...base, spawnMode: "rpc" }), /spawn rpc/);
	assert.match(metaBandFor({ ...base, spawnMode: "inprocess" }), /spawn inprocess/);
});

test("live overlay meta band keeps the spawn segment visible at the default 24x80 width (#209/D5)", () => {
	// `resolveModalLayout(24, 80)` gives innerWidth 78 and the band is clipped by
	// `fitLine`. Appended last after a REAL model id, `spawn inprocess` was cut
	// to `spawn inpr...`: the segment the whole change exists to show vanished
	// on the default layout. It now sits before the model, so role + spawn win.
	const band = metaBandFor({
		id: "root.worker",
		name: "worker",
		role: "worker",
		model: "workbuddy/deepseek-v4.1-flash",
		status: "running",
		parentId: "root",
		depth: 1,
		createdAt: 1_000,
		updatedAt: 1_000,
		spawnMode: "inprocess",
	});
	assert.match(band, /spawn inprocess/, "the full segment survives the 78-column clip");
	assert.doesNotMatch(band, /spawn inpr\.\.\.|spawn inpro\.\.\./, "no truncated spawn segment");
	// role and the spawn segment both precede the model id.
	assert.match(band, /worker · spawn inprocess · workbuddy\/deepseek-v4\.1-flash/);
});

test("live overlay meta band omits the spawn segment when the mode is unknown (#209/D5)", () => {
	const band = metaBandFor({
		id: "root.other",
		name: "other",
		role: "worker",
		model: null,
		status: "running",
		parentId: "root",
		depth: 1,
		createdAt: 1_000,
		updatedAt: 1_000,
	});
	// A legacy / tree-only node must not be labelled with a guessed backend.
	assert.doesNotMatch(band, /spawn /);
	assert.doesNotMatch(band, /rpc/);
	// The rest of the footer is unchanged.
	assert.match(band, /worker · turn 0 · 4s · running/);
});

test("resolveModalLayout caps frame by window ratio and keeps meta below the body", () => {
	const large = resolveModalLayout(50, 160);
	assert.equal(large.frameRows, Math.floor(50 * 0.65));
	assert.equal(large.innerWidth + 2, 160, "frame-local width fills the overlay rect it is mounted at");
	assert.equal(large.marginY, 0, "frame-local layout has no host mask margins to paint");
	assert.equal(large.marginX, 0);
	assert.equal(large.showMeta, true);
	assert.ok(large.metaRow !== null);
	assert.ok(large.metaRow! > large.bodyStartRow);
	assert.equal(large.footerRow, large.metaRow! + 1);
	assert.ok(large.frameRows < large.rows, "frame is shorter than the terminal");

	// The host overlay geometry is a percentage of the terminal, so pi-tui
	// re-derives it on every frame and the frame survives a resize (absolute cells
	// would freeze at open-time size and truncate the bottom border). Height is
	// left unset: the component renders exactly the frame rows, so its own height
	// is the rect — a cap would disagree with the minimum frame height on small
	// terminals and cut the border off.
	const overlay = resolveModalOverlayOptions();
	assert.equal(overlay.width, "75%", "overlay width tracks the frame ratio");
	assert.equal(overlay.maxHeight, undefined, "height comes from the component's own frame rows");
	assert.equal(overlay.anchor, "center");

	const small = resolveModalLayout(24, 80);
	assert.equal(small.frameRows, Math.floor(24 * 0.65));

	const tiny = resolveModalLayout(4, 80);
	assert.equal(tiny.frameRows, 4, "tiny terminals still fill height so body stays usable");
	assert.equal(tiny.bodyRows, 1);
	assert.equal(tiny.showMeta, true);
});

test("clicking the Esc hint closes the modal without stopping; clicks outside the frame never reach it", async () => {
	const source = new FakeOverlaySource();
	const stopped: string[] = [];
	const component = createLiveOverlay(source).open("root.worker", {
		terminalRows: 24,
		now: () => 5_000,
		onStop: (id) => stopped.push(id),
	});
	try {
		component.render(80);
		const layout = resolveModalLayout(24, 80);
		// #193: the overlay covers the frame rect only, so pi-tui never dispatches
		// outside clicks to this component — they land on the host chat / /legion
		// view that stays visible behind the frame. Prove it by dispatching a click
		// through the real compositor at a coordinate outside the frame.
		const { assertOutsideClickReachesHost } = await import("../helpers/modal-composite.ts");
		const outside = assertOutsideClickReachesHost({ rows: 24, cols: 80 });
		assert.equal(outside.componentGotClick, false, "click outside the frame is not delivered to the modal");
		assert.equal(outside.modalStillOpen, true, "outside click does not dismiss the modal");
		assert.equal(outside.hostHandledClick, true, "the click reached the host underlay instead");

		const again = createLiveOverlay(source).open("root.worker", {
			terminalRows: 24,
			now: () => 5_000,
			onStop: (id: string) => { stopped.push(id); },
		});
		again.render(80);
		const closeClick = again.handleMouse?.({
			type: "click",
			button: "left",
			x: layout.closeColStart,
			y: layout.titleRow,
			screenX: layout.closeColStart,
			screenY: layout.titleRow,
			width: 80,
			height: 24,
			shift: false,
			alt: false,
			ctrl: false,
		});
		assert.equal(closeClick?.handled, true);
		assert.equal(again.getState().open, false);
		assert.equal(stopped.length, 0, "close-hint click does not stop the agent");
	} finally {
		component.dispose();
	}
});

// #193 regression: drive the REAL pi-tui overlay compositor, because the bug is
// invisible at component level — it lives in how pi-tui replaces base cells.
// Kept in a dedicated file: it needs a TUI instance and a fake terminal.
// #193 regression: drive the REAL pi-tui overlay compositor, because the bug is
// invisible at component level — it lives in how pi-tui replaces base cells.
//
// The assertion is deliberately absolute (wipedRows === 0), NOT
// `visibleRows >= totalRows - frameRows`: that threshold is derived from the code
// under test, so the pre-fix full-screen geometry also satisfies it (9/24 visible,
// threshold 9) and the regression would pass. Only on sizes where the frame is
// actually inset from the terminal does "nothing wiped" hold; where the layout
// intentionally fills the screen (tiny terminals) we assert that instead.
test("the open modal leaves the host underlay visible (real pi-tui composite)", async () => {
	const { assertUnderlayVisible } = await import("../helpers/modal-composite.ts");
	for (const [rows, cols] of [[24, 80], [50, 160], [40, 120]] as const) {
		const result = assertUnderlayVisible({ rows, cols });
		assert.ok(result.frameInset, `${cols}x${rows}: frame must be inset from the terminal`);
		assert.equal(
			result.wipedRows,
			0,
			`${cols}x${rows}: host underlay must survive untouched (frame ${result.frameRows}x${result.frameCols}, wiped ${result.wipedRows})`,
		);
	}
});

test("the modal's right gutter keeps the /legion page background (real pi-tui composite, #308)", async () => {
	// The bug: with the /legion view as the base, the band between the frame's
	// right edge and the terminal's right edge rendered as the terminal's default
	// background — a black vertical stripe (#308). `wipedRows` cannot catch it (it
	// strips escapes, so the band's *text* was always base's); what was missing was
	// the *style*: pi-tui's compositor snapshots the SGR state of the base row at
	// the first cell after the overlay rect, and a /legion row ended in spaces
	// carrying no SGR at all. So this assertion keeps the escapes and compares the
	// background SGR in force at the first cell of each gutter, before vs after the
	// modal is composited on top.
	const { assertOverlayGutterInheritsBase, PAGE_FLOOR_ANSI } = await import("../helpers/modal-composite.ts");
	for (const [rows, cols] of [[24, 80], [40, 120]] as const) {
		const probe = assertOverlayGutterInheritsBase({ rows, cols });
		const tag = `${cols}x${rows}`;
		assert.ok(
			probe.bounds.col > 0 && probe.bounds.col + probe.bounds.width < cols,
			`${tag}: the 75% frame must leave a gutter on BOTH sides (rect ${JSON.stringify(probe.bounds)})`,
		);
		assert.ok(probe.gutters.length > 0, `${tag}: the frame must cover at least one row`);
		for (const gutter of probe.gutters) {
			const at = `${tag} row ${gutter.row}`;
			// The frame never paints outside its rect: gutter text is base's.
			assert.equal(gutter.frameLeft, gutter.baseLeft, `${at}: left gutter text must stay the base's`);
			assert.equal(gutter.frameRight, gutter.baseRight, `${at}: right gutter text must stay the base's`);
			// The floor covers the whole row, edge to edge.
			assert.equal(gutter.rowBg, PAGE_FLOOR_ANSI, `${at}: the /legion page must paint a floor from column 0`);
			assert.equal(gutter.baseLeftBg, PAGE_FLOOR_ANSI, `${at}: base left gutter must carry the floor`);
			assert.equal(gutter.baseRightBg, PAGE_FLOOR_ANSI, `${at}: base right gutter must carry the floor`);
			// …and the composited frame keeps exactly that style on both sides.
			assert.equal(
				gutter.frameLeftBg,
				gutter.baseLeftBg,
				`${at}: left gutter lost the base background (${JSON.stringify(gutter.frameLeftBg)} vs ${JSON.stringify(gutter.baseLeftBg)})`,
			);
			assert.equal(
				gutter.frameRightBg,
				gutter.baseRightBg,
				`${at}: right gutter fell back to the terminal default background ` +
					`(${JSON.stringify(gutter.frameRightBg)} vs base ${JSON.stringify(gutter.baseRightBg)})`,
			);
		}
	}
});

test("the /legion page mounted on the main screen keeps its floor under the modal's gutters (#347)", async () => {
	// #347 moved the page off the overlay stack (`ui.custom(..., { overlay: false })`,
	// so pi-tui composites nothing for it). The detail modal is still a 75% overlay,
	// and it is still composited over the page's rows — so #308's precondition is
	// unchanged: the page's row tails must still carry the floor, or the band right
	// of the frame falls back to the terminal's default background. This is the same
	// probe as the #308 case above with `mount: "main"`, the production geometry.
	const { assertOverlayGutterInheritsBase, PAGE_FLOOR_ANSI } = await import("../helpers/modal-composite.ts");
	for (const [rows, cols] of [[24, 80], [40, 120]] as const) {
		const probe = assertOverlayGutterInheritsBase({ rows, cols, mount: "main" });
		const tag = `${cols}x${rows}`;
		assert.equal(probe.mount, "main", `${tag}: the page must be mounted as a main-screen child`);
		assert.ok(
			probe.bounds.col > 0 && probe.bounds.col + probe.bounds.width < cols,
			`${tag}: the 75% frame must leave a gutter on BOTH sides (rect ${JSON.stringify(probe.bounds)})`,
		);
		assert.ok(probe.gutters.length > 0, `${tag}: the frame must cover at least one row`);
		for (const gutter of probe.gutters) {
			const at = `${tag} row ${gutter.row}`;
			assert.equal(gutter.frameLeft, gutter.baseLeft, `${at}: left gutter text must stay the base's`);
			assert.equal(gutter.frameRight, gutter.baseRight, `${at}: right gutter text must stay the base's`);
			// Floor on the base row, edge to edge — asserted non-empty first, because
			// `"" === ""` would let a paintPageFloor-free page pass.
			assert.equal(gutter.rowBg, PAGE_FLOOR_ANSI, `${at}: the /legion page must paint a floor from column 0`);
			assert.equal(gutter.baseRightBg, PAGE_FLOOR_ANSI, `${at}: base right gutter must carry the floor`);
			assert.equal(
				gutter.frameRightBg,
				PAGE_FLOOR_ANSI,
				`${at}: the composited right gutter fell back to the terminal default background ` +
					`(${JSON.stringify(gutter.frameRightBg)}) — paintPageFloor is still load-bearing on a main-screen mount`,
			);
			assert.equal(
				gutter.frameLeftBg,
				gutter.baseLeftBg,
				`${at}: left gutter lost the base background (${JSON.stringify(gutter.frameLeftBg)} vs ${JSON.stringify(gutter.baseLeftBg)})`,
			);
		}
	}
});

test("the modal frame survives a terminal resize (geometry is re-derived)", async () => {
	const { assertUnderlayVisibleAfterResize } = await import("../helpers/modal-composite.ts");
	for (const [from, to] of [
		[{ rows: 24, cols: 80 }, { rows: 50, cols: 160 }],
		[{ rows: 24, cols: 80 }, { rows: 12, cols: 40 }],
		[{ rows: 50, cols: 160 }, { rows: 24, cols: 80 }],
	] as const) {
		const result = assertUnderlayVisibleAfterResize(from, to);
		assert.equal(
			result.bounds.height,
			result.componentRows,
			`${from.cols}x${from.rows} -> ${to.cols}x${to.rows}: overlay rect must match the rendered frame ` +
				`(rect ${result.bounds.height} vs rendered ${result.componentRows}) — absolute geometry freezes at open size`,
		);
		assert.ok(result.bottomBorder, `${from.cols}x${from.rows} -> ${to.cols}x${to.rows}: bottom border must survive the resize`);
		assert.ok(result.footerHint, `${from.cols}x${from.rows} -> ${to.cols}x${to.rows}: Esc footer hint must survive the resize`);
	}
});

test("switching the open node updates modal title and content to the selected agent", () => {
	const source = new FakeOverlaySource();
	source.backfill = (nodeId) => {
		const text = nodeId === "root.other" ? "other-agent-context" : "worker-agent-context";
		const messages = [{ role: "user" as const, content: text, timestamp: 1 }];
		return { messages, cursor: cursor(1, 0, messages.length, 64) };
	};
	const overlay = createLiveOverlay(source);
	const first = overlay.open("root.worker", { terminalRows: 24, now: () => 5_000 });
	const firstPlain = stripTerminalSequences(first.render(80).join("\n"));
	assert.match(firstPlain, /● worker · 子/);
	assert.match(firstPlain, /worker-agent-context/);
	assert.doesNotMatch(firstPlain, /other-agent-context/);

	const second = overlay.open("root.other", { terminalRows: 24, now: () => 5_000 });
	assert.equal(first.getState().open, false);
	const secondPlain = stripTerminalSequences(second.render(80).join("\n"));
	assert.match(secondPlain, /● other · 子/);
	assert.match(secondPlain, /other-agent-context/);
	assert.doesNotMatch(secondPlain, /worker-agent-context/);

	const root = overlay.open("root", { terminalRows: 24, now: () => 5_000 });
	const rootPlain = stripTerminalSequences(root.render(80).join("\n"));
	assert.match(rootPlain, /● root · 主/);
	root.close();
});
