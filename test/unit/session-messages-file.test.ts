import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearOverlaySessionMessageCache,
	readSessionMessagesFile,
} from "../../src/tui/session-messages-file.ts";
import { parseSessionMessages } from "../../src/tui/chat-items.ts";

const user = (t: string) =>
	JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: t }], timestamp: 1 } });
const asst = (t: string) =>
	JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: t }],
			api: "openai-completions",
			provider: "openai",
			model: "test/model",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: 2,
		},
	});

function tmp(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "overlay-sess-")), "s.jsonl");
}

test("cold read matches parseSessionMessages of the whole file", () => {
	clearOverlaySessionMessageCache();
	const f = tmp();
	const text = `${user("a")}\n${asst("one")}\n`;
	fs.writeFileSync(f, text);
	const loaded = readSessionMessagesFile(f);
	assert.ok(loaded);
	assert.equal(loaded.messages.length, parseSessionMessages(text).length);
	assert.equal(loaded.messages.filter((m) => m.role === "user").length, 1);
	assert.equal(loaded.messages.filter((m) => m.role === "assistant").length, 1);
});

test("warm append only projects new lines (incremental seek)", () => {
	clearOverlaySessionMessageCache();
	const f = tmp();
	fs.writeFileSync(f, `${user("a")}\n${asst("one")}\n`);
	const first = readSessionMessagesFile(f);
	assert.ok(first);
	assert.equal(first.messages.length, 2);

	fs.appendFileSync(f, `${user("b")}\n${asst("two")}\n`);
	const second = readSessionMessagesFile(f);
	assert.ok(second);
	assert.equal(second.messages.length, 4);
	assert.equal(second.messages.filter((m) => m.role === "user").length, 2);
	assert.ok(second.fileSize > first.fileSize);
});

test("unchanged size returns cached messages without growing the cursor", () => {
	clearOverlaySessionMessageCache();
	const f = tmp();
	fs.writeFileSync(f, `${user("a")}\n${asst("one")}\n`);
	const first = readSessionMessagesFile(f);
	assert.ok(first);
	const second = readSessionMessagesFile(f);
	assert.ok(second);
	assert.equal(second.fileSize, first.fileSize);
	assert.equal(second.messages.length, first.messages.length);
});

test("trailing partial line is provisional and not committed", () => {
	clearOverlaySessionMessageCache();
	const f = tmp();
	fs.writeFileSync(f, `${user("a")}\n${asst("one")}\n`);
	assert.equal(readSessionMessagesFile(f)?.messages.length, 2);

	const a2 = asst("two");
	fs.appendFileSync(f, `${user("b")}\n${a2.slice(0, 40)}`);
	const mid = readSessionMessagesFile(f);
	assert.ok(mid);
	// user "b" is a complete line; assistant partial must not be committed.
	assert.equal(mid.messages.filter((m) => m.role === "user").length, 2);
	assert.equal(mid.messages.filter((m) => m.role === "assistant").length, 1);

	fs.appendFileSync(f, `${a2.slice(40)}\n`);
	const done = readSessionMessagesFile(f);
	assert.ok(done);
	assert.equal(done.messages.filter((m) => m.role === "assistant").length, 2);
	assert.deepEqual(
		done.messages.map((m) => m.role),
		parseSessionMessages(fs.readFileSync(f, "utf8")).map((m) => m.role),
	);
});

test("in-place rewrite invalidates the overlay cache via session fingerprint", () => {
	clearOverlaySessionMessageCache();
	const f = tmp();
	fs.writeFileSync(f, `${user("a")}\n${asst("old")}\n`);
	assert.equal(readSessionMessagesFile(f)?.messages.filter((m) => m.role === "assistant").length, 1);

	fs.writeFileSync(f, `${user("a")}\n${asst("new")}\n${user("c")}\n${asst("third")}\n`);
	const loaded = readSessionMessagesFile(f);
	assert.ok(loaded);
	assert.equal(loaded.messages.filter((m) => m.role === "user").length, 2);
	assert.equal(loaded.messages.filter((m) => m.role === "assistant").length, 2);
});

test("multi-megabyte append does not require re-reading the prefix", () => {
	clearOverlaySessionMessageCache();
	const f = tmp();
	// ~2.5MB of prior content (many small lines) then one append.
	const lines: string[] = [];
	for (let i = 0; i < 2000; i++) {
		lines.push(user(`pad-${i}-${"x".repeat(500)}`));
		lines.push(asst(`pad-out-${i}-${"y".repeat(500)}`));
	}
	fs.writeFileSync(f, `${lines.join("\n")}\n`);
	const cold = readSessionMessagesFile(f);
	assert.ok(cold);
	assert.ok(cold.fileSize > 2_000_000, `expected multi-MB fixture, got ${cold.fileSize}`);

	const before = cold.messages.length;
	fs.appendFileSync(f, `${user("tail")}\n${asst("tail-out")}\n`);
	const warm = readSessionMessagesFile(f);
	assert.ok(warm);
	assert.equal(warm.messages.length, before + 2);
	assert.equal(warm.messages.at(-1)?.role, "assistant");
});
