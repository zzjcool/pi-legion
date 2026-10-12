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
	createLiveOverlay,
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

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 } satisfies UserMessage;
}

function assistantMessage(
	text: string,
	options: { stopReason?: AssistantMessage["stopReason"]; toolCallId?: string; toolName?: string } = {},
): AgentMessage {
	const content: AssistantMessage["content"] = [];
	if (text) content.push({ type: "text", text });
	if (options.toolCallId) {
		content.push({
			type: "toolCall",
			id: options.toolCallId,
			name: options.toolName ?? "read",
			arguments: { path: "file.ts" },
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

function mouseEvent(y: number, type: TuiMouseEvent["type"] = "click"): TuiMouseEvent {
	return {
		type,
		button: "left",
		x: 1,
		y,
		screenX: 1,
		screenY: y,
		width: 80,
		height: 40,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

function toolResult(toolCallId: string, text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
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
	assert.equal(hideCount, 1, "Esc hides the attached overlay handle");
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
		assert.match(rendered, /worker \(worker\)/);
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
	const component = createLiveOverlay(source).open("root.worker", { terminalRows: 40 });
	try {
		const rendered = component.render(100).join("\n");
		assert.match(stripTerminalSequences(rendered), /Safe user text/);
		assert.match(stripTerminalSequences(rendered), /Safe assistant text/);
		assert.match(stripTerminalSequences(rendered), /Safe tool result/);
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
	const component = createLiveOverlay(source).open("root.worker", { terminalRows: 40 });
	try {
		const rendered = stripTerminalSequences(component.render(100).join("\n"));
		assert.match(rendered, /orphan output arrives first/);
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
		const headerLines = 1;
		const visibleToolLine = before.findIndex((line) => stripTerminalSequences(line).includes("read"));
		assert.ok(visibleToolLine >= headerLines, "tool component appears in the visible transcript");
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
	});
	try {
		const rendered = component.render(100).join("\n");
		assert.match(stripTerminalSequences(rendered), /Review the implementation/);
		assert.match(stripTerminalSequences(rendered), /read/);
		assert.match(stripTerminalSequences(rendered), /Thinking\.\.\./);
		assert.doesNotMatch(stripTerminalSequences(rendered), /private reasoning/);
		assert.match(stripTerminalSequences(rendered), /result line 1/);
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
		assert.match(collapsed, /more lines/);
		assert.doesNotMatch(collapsed, /result line 12/);
		component.handleInput?.("\u000f");
		const expanded = component.getState().text;
		assert.notEqual(expanded, collapsed);
		assert.match(expanded, /result line 12/);

		component.handleInput?.("g");
		assert.equal(component.getState().scrollTop, 0);
		component.handleInput?.("j");
		assert.equal(component.getState().scrollTop, 1, "j scrolls down one line");
		component.handleInput?.("k");
		assert.equal(component.getState().scrollTop, 0, "k scrolls up one line");
		component.handleInput?.("G");
		const maxScrollTop = Math.max(0, expanded.split("\n").length - 3);
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
