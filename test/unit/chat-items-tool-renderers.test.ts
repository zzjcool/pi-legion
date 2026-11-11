import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import {
	createChatItemFactory,
	parseSessionMessages,
	parseSessionMessagesWithMeta,
	type ChatItemFactory,
} from "../../src/tui/chat-items.ts";
import { createToolRendererLookup } from "../../src/tui/tool-renderers.ts";

// Unit tests run without the host Pi process that normally initializes theme.
initTheme("dark");

const TUI_STUB = {
	requestRender() {},
	terminal: { rows: 40, columns: 120 },
} as unknown as TUI;

const CWD = process.cwd();

function messageEntry(id: string, timestamp: string, message: Record<string, unknown>): string {
	return JSON.stringify({ type: "message", id, parentId: null, timestamp, message });
}

function assistantMessage(content: unknown[], stopReason: string, timestamp: number): Record<string, unknown> {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "openai",
		model: "test/model",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp,
	};
}

/**
 * A session with one finished bash tool call: the assistant asks for `echo hi`, the tool result
 * carries a recorded `durationMs` (the field `chat-items.ts` already forwarded into `updateResult`).
 */
function bashSession(options: { withResult?: boolean; durationMs?: number | null } = {}): string {
	const withResult = options.withResult ?? true;
	const durationMs = options.durationMs === undefined ? 4_200 : options.durationMs;
	const lines = [
		JSON.stringify({ type: "session", id: "sess-parity", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
		messageEntry("entry-user", "2026-01-01T00:00:01.000Z", { role: "user", content: "run the command", timestamp: 1 }),
		messageEntry(
			"entry-assistant",
			"2026-01-01T00:00:02.000Z",
			assistantMessage(
				[{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo hi" } }],
				"toolUse",
				2,
			),
		),
	];
	if (withResult) {
		lines.push(
			messageEntry("entry-result", "2026-01-01T00:00:03.000Z", {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: "hi" }],
				isError: false,
				...(durationMs === null ? {} : { durationMs }),
				timestamp: 3,
			}),
		);
	}
	return lines.join("\n");
}

/** A session whose tool name has no built-in renderer: it must keep the generic JSON block. */
function unknownToolSession(): string {
	return [
		JSON.stringify({ type: "session", id: "sess-unknown", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
		messageEntry(
			"entry-unknown",
			"2026-01-01T00:00:01.000Z",
			assistantMessage(
				[{ type: "toolCall", id: "call-legion", name: "legion_output", arguments: { node: "worker" } }],
				"toolUse",
				2,
			),
		),
	].join("\n");
}

function renderItems(factory: ChatItemFactory, width: number): string {
	return stripTerminalSequences(
		factory.items
			.filter((item) => !item.revoked)
			.map((item) => item.component.render(width).join("\n"))
			.join("\n"),
	);
}

/** The host components keep `messageId` private; that field is exactly what D9 forwards. */
function componentIdentity(component: object): { messageId?: string; timestamp?: string } {
	const { messageId, timestamp } = component as { messageId?: string; timestamp?: string };
	return { messageId, timestamp };
}

test("createToolRendererLookup maps built-in names and caches one definition per cwd (D1)", () => {
	const lookup = createToolRendererLookup(CWD);
	const bash = lookup("bash");
	assert.ok(bash, "bash has built-in renderers");
	assert.equal(typeof bash.renderCall, "function");
	assert.equal(typeof bash.renderResult, "function");
	assert.equal(lookup("bash"), bash, "the same cwd reuses the cached definition");
	assert.equal(lookup("legion_output"), undefined, "unknown tool names have no built-in renderers");
	const otherCwd = "/definitely/not/the/same/cwd";
	assert.equal(
		createToolRendererLookup(otherCwd)("bash"),
		createToolRendererLookup(otherCwd)("bash"),
		"a second lookup for the same cwd shares the cache",
	);
	assert.notEqual(createToolRendererLookup(otherCwd)("bash"), bash, "each cwd builds its own definition");
});

test("a replayed bash tool block renders through the built-in renderer with its real duration (D1/D2)", () => {
	const factory = createChatItemFactory({ tui: TUI_STUB, cwd: CWD });
	try {
		factory.appendMessages(parseSessionMessages(bashSession()));
		const rendered = renderItems(factory, 120);
		// (a) R2: the exact wording belongs to the host; only "a duration after Took" is asserted.
		assert.match(rendered, /Took[^\n]*4\.2s/, `final result shows the recorded duration, got:\n${rendered}`);
		// (b) the shell renderer prints the command; the generic `JSON.stringify(args)` block is gone.
		assert.match(rendered, /echo hi/, "the built-in shell renderer prints the command text");
		assert.doesNotMatch(rendered, /"command"/, "the JSON fallback's arg field names are gone");
	} finally {
		factory.releaseToolTimers();
	}
});

test("an unknown tool name keeps the generic block and never throws (D1)", () => {
	assert.equal(createToolRendererLookup(CWD)("legion_output"), undefined);
	const factory = createChatItemFactory({ tui: TUI_STUB, cwd: CWD });
	try {
		assert.doesNotThrow(() => factory.appendMessages(parseSessionMessages(unknownToolSession())));
		const rendered = renderItems(factory, 120);
		assert.match(rendered, /legion_output/, "the fallback block names the tool");
		assert.match(rendered, /worker/, "the fallback block still shows its arguments");
	} finally {
		factory.releaseToolTimers();
	}
});

test("updateToolArgs re-renders an in-flight tool and markToolStarted is idempotent (D6/D8)", () => {
	const factory = createChatItemFactory({ tui: TUI_STUB, cwd: CWD });
	try {
		factory.appendMessages(parseSessionMessages(bashSession({ withResult: false })));
		assert.match(renderItems(factory, 120), /echo hi/, "the call is rendered before any result");
		factory.updateToolArgs("call-1", { command: "echo bye" });
		factory.markToolStarted("call-1");
		factory.markToolStarted("call-1");
		const rendered = renderItems(factory, 120);
		assert.match(rendered, /echo bye/, "streamed arguments replace the original ones");
		assert.doesNotMatch(rendered, /echo hi/);
		// Unknown ids are silent no-ops, never throws.
		assert.doesNotThrow(() => {
			factory.updateToolArgs("no-such-call", { command: "ignored" });
			factory.markToolStarted("no-such-call");
		});
		// D3/D16: `releaseToolTimers` is the v2 hook that clears the host's 1s tick. A replayed block
		// never starts that clock (D16), so the release is a no-op — it must stay silent and idempotent,
		// and it must not fabricate a final result (that would print a fake `Took 0.0s`).
		factory.releaseToolTimers();
		assert.doesNotThrow(() => factory.releaseToolTimers(), "releaseToolTimers is idempotent");
		assert.match(renderItems(factory, 120), /echo bye/, "the call row survives the release");
	} finally {
		factory.releaseToolTimers();
	}
});

test("a historical result without durationMs prints no fabricated timer (D16)", () => {
	const factory = createChatItemFactory({ tui: TUI_STUB, cwd: CWD });
	try {
		factory.appendMessages(parseSessionMessages(bashSession({ durationMs: null })));
		const rendered = renderItems(factory, 120);
		assert.match(rendered, /echo hi/, "the call still renders through the shell renderer");
		assert.doesNotMatch(rendered, /Took/, "no fake duration is printed for a result that recorded none");
		assert.doesNotMatch(rendered, /Elapsed/, "replay does not start the clock either");
	} finally {
		factory.releaseToolTimers();
	}
});

test("appendStreamingThinking accumulates thinking before text in one streaming item (D4/D5)", () => {
	const factory = createChatItemFactory({ tui: TUI_STUB, cwd: CWD, settings: { hideThinkingBlock: false } });
	try {
		const component = factory.appendStreamingThinking("step one", "test/model");
		factory.appendStreamingThinking(" and step two");
		factory.updateStreamingText("the answer");
		assert.deepEqual(
			factory.streamingParts(),
			{ text: "the answer", thinking: "step one and step two" },
			"the streaming snapshot covers both runs",
		);
		const rendered = stripTerminalSequences(component.render(120).join("\n"));
		assert.match(rendered, /step one and step two/, "streamed thinking reaches the transcript");
		assert.match(rendered, /the answer/);
		assert.ok(
			rendered.indexOf("step one") < rendered.indexOf("the answer"),
			"thinking renders before text",
		);
		assert.equal(
			factory.items.filter((item) => item.kind === "assistant").length,
			1,
			"thinking and text share one streaming component",
		);
		factory.finishStreaming();
		assert.deepEqual(factory.streamingParts(), { text: "", thinking: "" }, "finishStreaming clears the accumulation");
	} finally {
		factory.releaseToolTimers();
	}
});

test("session entry ids and timestamps reach the user and assistant components (D9)", () => {
	const withMeta = parseSessionMessagesWithMeta(bashSession());
	assert.equal(withMeta.meta.length, withMeta.messages.length, "one metadata record per message");
	const [userMeta, assistantMeta] = withMeta.meta;
	assert.ok(userMeta && typeof userMeta.entryId === "string" && userMeta.entryId.length > 0, "the user entry keeps an id");
	assert.equal(userMeta.timestamp, "2026-01-01T00:00:01.000Z", "the entry timestamp is forwarded as an ISO string");
	assert.ok(assistantMeta && typeof assistantMeta.entryId === "string" && assistantMeta.entryId.length > 0);
	assert.equal(assistantMeta.timestamp, "2026-01-01T00:00:02.000Z");
	// The existing export keeps its signature and behaviour.
	assert.equal(parseSessionMessages(bashSession()).length, withMeta.messages.length);

	const factory = createChatItemFactory({ tui: TUI_STUB, cwd: CWD });
	try {
		factory.appendMessages(withMeta.messages);
		const user = factory.items.find((item) => item.kind === "user");
		assert.ok(user, "the user message is in the transcript");
		assert.deepEqual(
			componentIdentity(user.component),
			{ messageId: userMeta.entryId, timestamp: userMeta.timestamp },
			"messageId/timestamp come from the user entry",
		);
		const assistant = factory.items.find((item) => item.kind === "assistant");
		assert.ok(assistant, "the assistant message is in the transcript");
		assert.deepEqual(
			componentIdentity(assistant.component),
			{ messageId: assistantMeta.entryId, timestamp: assistantMeta.timestamp },
			"messageId/timestamp come from the assistant entry",
		);
	} finally {
		factory.releaseToolTimers();
	}
});
