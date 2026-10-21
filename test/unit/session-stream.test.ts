import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearSessionParseCache, countAssistantMessages, deriveOutcome, parseSessionFile, parseSessionText, readSessionJsonlDelta, SESSION_CACHE_MAX_ENTRIES, sessionParseCacheHas, sessionParseCacheSize } from "../../src/shared/session.ts";

const user = (t: string) => JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: t }] } });
const asst = (t: string) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: t }], stopReason: "stop", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } } });
const asstWithTools = (t: string, tools: string[]) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: t }, ...tools.map((name) => ({ type: "toolCall", name }))], stopReason: "toolUse", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } } });
const tool = (err: boolean) => JSON.stringify({ type: "message", message: { role: "toolResult", isError: err, content: [{ type: "text", text: "x" }] } });

function tmp(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sess-")), "s.jsonl");
}

test("streamed parse equals whole-text parse", () => {
	clearSessionParseCache();
	const f = tmp();
	const text = [user("a"), asst("one"), tool(true), user("b"), asst("two"), "{torn"].join("\n");
	fs.writeFileSync(f, text);
	assert.deepEqual(parseSessionFile(f), parseSessionText(text));
});

test("incremental append parses only new bytes and matches full parse", () => {
	clearSessionParseCache();
	const f = tmp();
	fs.writeFileSync(f, `${user("a")}\n${asst("one")}\n`);
	assert.equal(parseSessionFile(f).turns.length, 1);
	// partial line in progress: provisional, not committed
	const a2 = asst("two");
	fs.appendFileSync(f, `${user("b")}\n${a2.slice(0, 20)}`);
	const mid = parseSessionFile(f);
	assert.equal(mid.turns.length, 2);
	assert.equal(mid.lastTurnMissing, true);
	fs.appendFileSync(f, `${a2.slice(20)}\n`);
	const full = fs.readFileSync(f, "utf8");
	assert.deepEqual(parseSessionFile(f), parseSessionText(full));
	assert.equal(parseSessionFile(f).lastTurnOutput, "two");
});

test("in-place rewrite with different content invalidates the cache", () => {
	clearSessionParseCache();
	const f = tmp();
	fs.writeFileSync(f, `${user("a")}\n${asst("old")}\n`);
	assert.equal(parseSessionFile(f).lastTurnOutput, "old");
	fs.writeFileSync(f, `${user("a")}\n${asst("new")}\n${user("c")}\n${asst("third")}\n`);
	assert.equal(parseSessionFile(f).lastTurnOutput, "third");
	assert.equal(parseSessionFile(f).turns.length, 2);
	fs.writeFileSync(f, `${user("z")}\n`);
	assert.equal(parseSessionFile(f).turns.length, 1);
});

test("callers cannot corrupt the cache by mutating the result", () => {
	clearSessionParseCache();
	const f = tmp();
	fs.writeFileSync(f, `${user("a")}\n${asst("one")}\n`);
	const r = parseSessionFile(f);
	r.turns.length = 0;
	assert.equal(parseSessionFile(f).turns.length, 1);
});

/*
 * The five hazard scenarios below are the ones that make a *shallow* copy
 * unsafe (#237 P7). `turns.slice()` alone satisfies the test above and still
 * corrupts the cache, so each mutation point in the parse fold gets its own
 * assertion here.
 */

test("callers cannot corrupt the cache through the returned usage object", () => {
	clearSessionParseCache();
	const f = tmp();
	fs.writeFileSync(f, `${user("a")}\n${asst("one")}\n`);
	const r = parseSessionFile(f);
	const cached = { ...r.usage };
	r.usage.input = 9999;
	r.usage.cost = 9999;
	const next = parseSessionFile(f);
	assert.equal(next.usage.input, cached.input);
	assert.equal(next.usage.cost, cached.cost);
	assert.notEqual(next.usage, r.usage, "the returned usage must be its own object");
});

test("callers cannot retro-mutate a cached turn", () => {
	clearSessionParseCache();
	const f = tmp();
	fs.writeFileSync(f, `${user("a")}\n${asst("one")}\n${user("b")}\n${asst("two")}\n`);
	const r = parseSessionFile(f);
	const turn = r.turns[0];
	assert.ok(turn);
	const before = { endedAt: turn.endedAt, toolResults: turn.toolResults, toolErrors: turn.toolErrors };
	turn.endedAt = 0;
	turn.toolResults = 99;
	turn.toolErrors = 99;
	const next = parseSessionFile(f);
	assert.deepEqual(
		{ endedAt: next.turns[0]?.endedAt, toolResults: next.turns[0]?.toolResults, toolErrors: next.turns[0]?.toolErrors },
		before,
	);
	assert.notEqual(next.turns[0], turn, "turns must be fresh objects, not shared");
});

test("callers cannot grow a cached turn's assistants array", () => {
	clearSessionParseCache();
	const f = tmp();
	fs.writeFileSync(f, `${user("a")}\n${asst("one")}\n`);
	const r = parseSessionFile(f);
	const assistants = r.turns[0]?.assistants;
	assert.ok(assistants);
	const length = assistants.length;
	assistants.push({ stopReason: "stop", errorMessage: null, text: "injected", tools: [] });
	const next = parseSessionFile(f);
	assert.equal(next.turns[0]?.assistants.length, length);
	assert.equal(countAssistantMessages(next), length);
	assert.notEqual(next.turns[0]?.assistants, assistants, "assistants must be its own array");
});

/*
 * The provisional-tail guard — the assertion that actually decides the copy
 * depth. The last assistant line is written WITHOUT a trailing newline, so the
 * first parse applies it provisionally via `applyLine(result, ...)`. That
 * provisional parse walks `currentTurn(result)` → `result.turns.at(-1)`.
 *
 * If the returned turn is the cached turn, the provisional assistant is pushed
 * into the CACHE; when the newline lands and the line is committed for real,
 * `applyAssistant` pushes it again → 2, then 3. A `turns.slice()`-only
 * projection fails here while passing every other test in this file.
 */
test("a provisional tail line is not committed into the cache twice", () => {
	clearSessionParseCache();
	const f = tmp();
	const body = `${user("a")}\n${asst("one")}\n${user("b")}\n${asst("two")}`;
	fs.writeFileSync(f, body); // no trailing newline: line is provisional

	const first = parseSessionFile(f);
	assert.equal(countAssistantMessages(first), 2, "provisional parse sees both assistants");
	assert.deepEqual(first.turns.map((t) => t.assistants.length), [1, 1]);

	fs.appendFileSync(f, "\n"); // the write completes; now it is committed
	const second = parseSessionFile(f);
	assert.equal(countAssistantMessages(second), 2, "the committed line must not be counted again");
	assert.deepEqual(second.turns.map((t) => t.assistants.length), [1, 1]);
	assert.equal(second.lastTurnOutput, "two");

	// Same again for a single-turn session whose provisional line lands in the
	// turn the cache already holds — the tightest form of the hazard.
	const g = tmp();
	clearSessionParseCache();
	fs.writeFileSync(g, `${user("c")}\n${asst("three")}\n${asst("four")}`);
	assert.equal(countAssistantMessages(parseSessionFile(g)), 2);
	fs.appendFileSync(g, "\n");
	const single = parseSessionFile(g);
	assert.equal(countAssistantMessages(single), 2);
	assert.deepEqual(single.turns.map((t) => t.assistants.length), [2]);
});

test("deriveOutcome usage does not drift when the session grows", () => {
	clearSessionParseCache();
	const f = tmp();
	fs.writeFileSync(f, `${user("a")}\n${asst("one")}\n`);
	const before = deriveOutcome(parseSessionFile(f)).usage;
	assert.ok(before);
	const snapshot = { ...before };

	// `deriveOutcome` hands `parsed.usage` straight to the caller, so a shared
	// usage object would let the cache keep accumulating into a held snapshot.
	fs.appendFileSync(f, `${user("b")}\n${asst("two")}\n`);
	const after = parseSessionFile(f);
	assert.deepEqual({ ...before }, snapshot, "a held usage snapshot must not move");
	assert.ok(after.usage.input > snapshot.input, "the growing parse still accumulates");
	assert.deepEqual({ ...deriveOutcome(after).usage }, { ...after.usage });
});

/*
 * The assistant OBJECT layer, not just its array.
 *
 * The cheapest version of D1 that passes every other test in this file is
 * `assistants: t.assistants.slice()` — a fresh array whose elements are still
 * the cached assistant objects. Nothing in the production fold writes an
 * assistant after constructing it (they are built once as a literal at
 * `session.ts:208`), so that variant looks correct and silently reintroduces
 * the alias: a caller writing `assistants[0].text` poisons the cache, and
 * `finalizeParsed` then reports the poisoned text as `lastTurnOutput` on the
 * NEXT parse. Any future "simplification" of the projection must fail here.
 */
test("callers cannot mutate a cached assistant object or its tools array", () => {
	clearSessionParseCache();
	const f = tmp();
	const text = `${user("a")}\n${asstWithTools("one", ["bash", "read"])}\n`;
	fs.writeFileSync(f, text);
	const truth = parseSessionText(text);

	const r = parseSessionFile(f);
	const assistant = r.turns[0]?.assistants[0];
	assert.ok(assistant);
	assert.deepEqual(assistant.tools, ["bash", "read"]);

	assistant.text = "HACKED";
	assistant.tools.push("EVIL");

	const next = parseSessionFile(f);
	assert.equal(next.turns[0]?.assistants[0]?.text, truth.turns[0]?.assistants[0]?.text);
	assert.equal(next.lastTurnOutput, truth.lastTurnOutput);
	assert.deepEqual(next.turns[0]?.assistants[0]?.tools, truth.turns[0]?.assistants[0]?.tools);
	assert.notEqual(next.turns[0]?.assistants[0], assistant, "assistant objects must not be shared");
	assert.notEqual(next.turns[0]?.assistants[0]?.tools, assistant.tools, "tools must not be shared");
});

test("the parse cache is bounded by SESSION_CACHE_MAX_ENTRIES", () => {
	clearSessionParseCache();
	assert.equal(sessionParseCacheSize(), 0);
	const files = Array.from({ length: SESSION_CACHE_MAX_ENTRIES + 3 }, () => tmp());
	for (const file of files) {
		fs.writeFileSync(file, `${user("a")}\n${asst("one")}\n`);
		parseSessionFile(file);
	}
	assert.equal(sessionParseCacheSize(), SESSION_CACHE_MAX_ENTRIES);
	// Evicted paths must still parse correctly from byte 0.
	assert.equal(countAssistantMessages(parseSessionFile(files[0] as string)), 1);
	clearSessionParseCache();
});

/*
 * The cap is an LRU, not a FIFO: `parseSessionFile` deletes then re-sets the
 * entry on every call, so a cache HIT re-seats the path as most-recently-used.
 * This is the only assertion that distinguishes the two orders.
 *
 * Fill to exactly the cap, touch the OLDEST entry, then insert one more. Under
 * LRU the touched path survives and the next-oldest goes; under FIFO the
 * touched path is evicted for still being the oldest.
 */
test("the parse cache evicts the least-recently-used path, not the oldest", () => {
	clearSessionParseCache();
	const files = Array.from({ length: SESSION_CACHE_MAX_ENTRIES }, () => tmp());
	for (const file of files) {
		fs.writeFileSync(file, `${user("a")}\n${asst("one")}\n`);
		parseSessionFile(file);
	}
	assert.equal(sessionParseCacheSize(), SESSION_CACHE_MAX_ENTRIES);

	// Insertion order is files[0] .. files[63]; touch the head so it moves to tail.
	parseSessionFile(files[0] as string);

	const overflow = tmp();
	fs.writeFileSync(overflow, `${user("a")}\n${asst("one")}\n`);
	parseSessionFile(overflow);
	assert.equal(sessionParseCacheSize(), SESSION_CACHE_MAX_ENTRIES);

	assert.equal(sessionParseCacheHas(files[0] as string), true, "a touched entry must survive (FIFO would drop it)");
	assert.equal(sessionParseCacheHas(files[1] as string), false, "the least-recently-used entry is the one evicted");
	assert.equal(sessionParseCacheHas(overflow), true);
	clearSessionParseCache();
});

test("oversized single line is skipped as torn without materialising it", () => {
	clearSessionParseCache();
	const prev = process.env.PI_LEGION_SESSION_MAX_LINE_BYTES;
	process.env.PI_LEGION_SESSION_MAX_LINE_BYTES = "4096";
	try {
		const f = tmp();
		const huge = JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "y".repeat(3 * 1024 * 1024) }] } });
		fs.writeFileSync(f, `${user("a")}\n${huge}\n${asst("after")}\n`);
		const r = parseSessionFile(f);
		assert.equal(r.tornLines, 1);
		assert.equal(r.lastTurnOutput, "after");
	} finally {
		if (prev === undefined) delete process.env.PI_LEGION_SESSION_MAX_LINE_BYTES; else process.env.PI_LEGION_SESSION_MAX_LINE_BYTES = prev;
	}
});

test("missing file yields empty", () => {
	assert.equal(parseSessionFile("/nonexistent/x.jsonl").turns.length, 0);
});

test("readSessionJsonlDelta seeks from previous.offset and leaves provisional uncommitted", () => {
	const f = tmp();
	fs.writeFileSync(f, `${user("a")}\n${asst("one")}\n`);
	const first = readSessionJsonlDelta(f, undefined);
	assert.ok(first);
	assert.equal(first.lines.length, 2);
	assert.equal(first.provisional, "");
	assert.equal(first.cursor.offset, fs.statSync(f).size);

	const a2 = asst("two");
	fs.appendFileSync(f, `${user("b")}\n${a2.slice(0, 24)}`);
	const mid = readSessionJsonlDelta(f, first.cursor);
	assert.ok(mid);
	assert.equal(mid.reset, false);
	assert.equal(mid.lines.length, 1, "only the complete user line is committed");
	assert.ok(mid.provisional.startsWith(a2.slice(0, 8)));
	assert.equal(mid.cursor.offset, first.cursor.offset + Buffer.byteLength(`${user("b")}\n`));

	fs.appendFileSync(f, `${a2.slice(24)}\n`);
	const done = readSessionJsonlDelta(f, mid.cursor);
	assert.ok(done);
	assert.equal(done.lines.length, 1);
	assert.equal(done.provisional, "");
	assert.equal(done.cursor.offset, fs.statSync(f).size);
});
