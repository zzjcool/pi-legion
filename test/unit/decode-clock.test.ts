/**
 * `decode-clock.ts` — the measured tok/s denominator (contract
 * `docs/contracts/tps-decode-denominator-v1.md` D2).
 *
 * A note on why these cases are shaped the way they are: the fold's whole job is
 * to sum `first delta → last delta` per assistant message and to fall back to
 * `durationMs` when there was nothing to measure. So every case below pins BOTH
 * halves — an implementation that always used the span would look green on the
 * streaming cases and silently divide by ~0 on a non-streaming provider, and one
 * that always used `durationMs` would be today's bug.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { foldDecode, seedDecode, MIN_MEASURED_DECODE_MS, type DecodeClock } from "../../src/supervisor/decode-clock.ts";

const T0 = 1_700_000_000_000;
/** A streaming text delta at host-clock `at`. */
const textDelta = (delta = "x") => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
/** A streaming thinking delta — the one `publishEvent`'s filter drops. */
const thinkingDelta = (delta = "hmm") => ({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta } });
/** The assistant `message_end` that closes a message, with its request-inclusive cost. */
const messageEnd = (durationMs?: number) => ({ type: "message_end", message: { role: "assistant", ...(durationMs === undefined ? {} : { durationMs }) } });

/** Fold a list of `[record, at]` pairs in order, starting from `seed`. */
function foldAll(seed: number, steps: Array<[Record<string, unknown>, number]>): DecodeClock {
	let clock = seedDecode(seed);
	for (const [record, at] of steps) clock = foldDecode(clock, record, at);
	return clock;
}

test("decode clock: a message measures first delta → last delta, not the request", () => {
	// 2s of real streaming inside a 12s request: the contract's measured shape
	// (durationMs ≈ 4.3s + output/137), where the request cost dwarfs the decode.
	const clock = foldAll(0, [
		[{ type: "message_start", message: { role: "assistant" } }, T0],
		[textDelta(), T0 + 1_000],
		[textDelta(), T0 + 2_000],
		[textDelta(), T0 + 3_000],
		[messageEnd(12_000), T0 + 12_000],
	]);
	assert.equal(clock.measuredMs, 2_000, "span wins over the 12s request");
	assert.equal(clock.openSince, undefined, "a closed message leaves nothing open");
	assert.equal(clock.openLast, undefined);
});

test("decode clock: _start / _end / done boundary events are not stream activity", () => {
	// Counting them would stretch the span over the prefill: the exact defect this
	// module replaces. Only `*_delta` may move the clock.
	const clock = foldAll(0, [
		[{ type: "message_update", assistantMessageEvent: { type: "start" } }, T0],
		[{ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }, T0 + 100],
		[textDelta(), T0 + 500],
		[textDelta(), T0 + 1_500],
		[{ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0 } }, T0 + 1_600],
		[{ type: "message_update", assistantMessageEvent: { type: "done" } }, T0 + 1_700],
		[messageEnd(9_000), T0 + 9_000],
	]);
	assert.equal(clock.measuredMs, 1_000, "only the two deltas bound the span");
});

test("decode clock: thinking-only and toolcall deltas count too", () => {
	// The reason the fold hangs above `publishEvent`'s filter: a thinking-only turn
	// emits no text_delta at all, so a filter-side hook would measure nothing.
	const clock = foldAll(0, [
		[thinkingDelta(), T0],
		[thinkingDelta(), T0 + 800],
		[textDelta(), T0 + 1_600],
		[{ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: "{" } }, T0 + 2_400],
		[messageEnd(7_000), T0 + 7_000],
	]);
	assert.equal(clock.measuredMs, 2_400);
});

test("decode clock: a message that ONLY thinks still measures its span", () => {
	// The shape that made D1 hang the fold above `publishEvent`'s filter: a
	// thinking-only turn emits no text_delta and no tool name, so a filter-side hook
	// would measure nothing at all for the whole message.
	const clock = foldAll(0, [
		[{ type: "message_start", message: { role: "assistant" } }, T0],
		[{ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }, T0 + 100],
		[thinkingDelta(), T0 + 400],
		[thinkingDelta(), T0 + 1_900],
		[thinkingDelta(), T0 + 3_300],
		[{ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } }, T0 + 3_400],
		[messageEnd(11_000), T0 + 11_000],
	]);
	assert.equal(clock.measuredMs, 2_900, "first→last thinking delta, not the 11s request");
});

test("decode clock: a message that ONLY streams tool-call arguments measures its span", () => {
	// Agentic shape: the assistant answers with a tool call, so the whole message is
	// `toolcall_delta` frames around the tool name. No text, no thinking.
	const toolcallDelta = (delta: string) => ({
		type: "message_update",
		assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta },
	});
	const clock = foldAll(0, [
		[{ type: "message_start", message: { role: "assistant" } }, T0],
		[{ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "bash" } }, T0 + 200],
		[toolcallDelta('{"command":'), T0 + 600],
		[toolcallDelta('"ls"}'), T0 + 1_300],
		[{ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0 } }, T0 + 1_400],
		[messageEnd(8_000), T0 + 8_000],
	]);
	assert.equal(clock.measuredMs, 700, "only the two argument deltas bound the span");
});

test("decode clock: a span under MIN_MEASURED_DECODE_MS falls back to that message's durationMs", () => {
	// A provider that does not stream (single chunk) or a message whose deltas all
	// landed in one millisecond: nothing to divide by, so keep today's behaviour
	// rather than collapsing the denominator.
	const under = foldAll(0, [
		[textDelta(), T0 + 1_000],
		[textDelta(), T0 + 1_000 + (MIN_MEASURED_DECODE_MS - 1)],
		[messageEnd(4_000), T0 + 5_000],
	]);
	assert.equal(under.measuredMs, 4_000, "short span → durationMs");

	// Exactly at the bound it is trusted (>= is the contract's rule).
	const at = foldAll(0, [
		[textDelta(), T0],
		[textDelta(), T0 + MIN_MEASURED_DECODE_MS],
		[messageEnd(4_000), T0 + 9_000],
	]);
	assert.equal(at.measuredMs, MIN_MEASURED_DECODE_MS, "at the bound the span is used");

	// No stream at all (single-chunk response): durationMs is all there is.
	const single = foldAll(0, [
		[{ type: "message_start", message: { role: "assistant" } }, T0],
		[messageEnd(4_300), T0 + 4_300],
	]);
	assert.equal(single.measuredMs, 4_300);

	// Neither: nothing is added, and nothing throws.
	const nothing = foldAll(0, [[{ type: "message_end", message: { role: "assistant" } }, T0]]);
	assert.equal(nothing.measuredMs, 0);
});

test("decode clock: a hanging message is settled by the next activity, never merged into it", () => {
	// Aborted turn / killed child: no `message_end` ever arrives. The open span must
	// be banked as-is; if it merged into the next message the idle gap would be
	// counted as decoding time.
	const clock = foldAll(0, [
		[textDelta(), T0],
		[textDelta(), T0 + 1_000],
		// aborted here — no message_end
		[{ type: "turn_end", message: { role: "assistant", stopReason: "aborted" } }, T0 + 20_000],
		[{ type: "turn_start" }, T0 + 30_000],
		[{ type: "message_start", message: { role: "assistant" } }, T0 + 30_100],
		[textDelta(), T0 + 30_500],
		[textDelta(), T0 + 31_500],
		[messageEnd(6_000), T0 + 36_000],
	]);
	// 1s from the abandoned message + 1s from the second one — NOT the 30s gap.
	assert.equal(clock.measuredMs, 2_000);

	// The same unclosed span must also be closed when only the next message's own
	// `start`/first delta shows up (no turn boundary in between).
	const silent = foldAll(0, [
		[textDelta(), T0],
		[textDelta(), T0 + 700],
		[{ type: "message_start", message: { role: "assistant" } }, T0 + 40_000],
		[textDelta(), T0 + 40_200],
		[messageEnd(5_000), T0 + 45_000],
	]);
	assert.equal(silent.measuredMs, 700 + 5_000, "second message had no measurable span → durationMs");
});

test("decode clock: unknown / malformed records leave the clock untouched (total function)", () => {
	let clock = seedDecode(0);
	const records: unknown[] = [
		{},
		{ type: 42 },
		{ type: "unknown_thing", payload: { delta: "x" } },
		{ type: "message_update" },
		{ type: "message_update", assistantMessageEvent: {} },
		{ type: "message_update", assistantMessageEvent: { type: 7 } },
		{ type: "message_end" },
		{ type: "message_end", message: "not an object" },
		{ type: "tool_execution_start", toolName: "bash" },
		null,
		undefined,
		"message_end",
		17,
	];
	for (const record of records) {
		const before = { ...clock };
		clock = foldDecode(clock, record as Record<string, unknown>, T0);
		assert.deepEqual(clock, before, `record ${JSON.stringify(record)} changed the clock`);
	}
	// A non-finite clock reading is not a measurement either.
	const kept = foldDecode(clock, textDelta(), Number.NaN);
	assert.deepEqual(kept, clock);
	// Malformed durationMs values are ignored rather than trusted.
	const weird = foldAll(0, [[{ type: "message_end", message: { role: "assistant", durationMs: "4000" } }, T0]]);
	assert.equal(weird.measuredMs, 0);
	const negative = foldAll(0, [[{ type: "message_end", message: { role: "assistant", durationMs: -5 } }, T0]]);
	assert.equal(negative.measuredMs, 0);
});

test("decode clock: measuredMs only ever grows, and a resume seed is preserved", () => {
	// D3: a resumed child's history is `generationMs`; the measured part adds on top
	// so the sampler sees one continuous, monotone axis.
	const seed = seedDecode(45_000);
	assert.equal(seed.measuredMs, 45_000);
	assert.deepEqual(seedDecode(-1), { measuredMs: 0 });
	assert.deepEqual(seedDecode(Number.NaN), { measuredMs: 0 });

	let clock = seed;
	let previous = clock.measuredMs;
	const steps: Array<[Record<string, unknown>, number]> = [
		[textDelta(), T0],
		[textDelta(), T0 + 900],
		[messageEnd(5_000), T0 + 5_000],
		[textDelta(), T0 + 6_000],
		[{ type: "error", reason: "boom" }, T0 + 7_000],
		[textDelta(), T0 + 8_000],
		[textDelta(), T0 + 9_500],
		[messageEnd(5_000), T0 + 10_000],
	];
	for (const [record, at] of steps) {
		clock = foldDecode(clock, record, at);
		assert.ok(clock.measuredMs >= previous, `measuredMs regressed at ${at}: ${clock.measuredMs} < ${previous}`);
		previous = clock.measuredMs;
	}
	// 900ms before the first end, nothing for the errored-out empty span, 1500ms after.
	assert.equal(clock.measuredMs, 45_000 + 900 + 1_500);
});

test("decode clock: a non-assistant message_end closes the span without borrowing durationMs", () => {
	// A toolResult/user message_end can only ever follow an assistant message that
	// already closed itself; if one arrives with a span open, the stream is over —
	// bank it, but never read `durationMs` off a message that has no request cost.
	const clock = foldAll(0, [
		[textDelta(), T0],
		[textDelta(), T0 + 1_200],
		[{ type: "message_end", message: { role: "toolResult", durationMs: 99_000 } }, T0 + 2_000],
	]);
	assert.equal(clock.measuredMs, 1_200);
});

test("decode clock: a successful turn's two messages add up independently", () => {
	// Agentic turn: text message → tool call → second message. Each message has its
	// own measured span; the tool gap in between is idle, not decoding.
	const clock = foldAll(0, [
		[textDelta(), T0],
		[textDelta(), T0 + 1_000],
		[messageEnd(8_000), T0 + 2_000],
		[{ type: "tool_execution_start", toolName: "bash" }, T0 + 2_100],
		[{ type: "tool_execution_end", toolName: "bash" }, T0 + 9_000],
		[{ type: "message_start", message: { role: "assistant" } }, T0 + 9_100],
		[textDelta(), T0 + 9_500],
		[textDelta(), T0 + 11_000],
		[messageEnd(9_000), T0 + 13_000],
	]);
	assert.equal(clock.measuredMs, 1_000 + 1_500);
});
