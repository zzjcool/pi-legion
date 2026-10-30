/**
 * #313: a steer receipt must not claim delivery it did not get.
 *
 * Pi delivers a steer after the child's current tool batch finishes and before
 * its next LLM call, so a message sent into a running tool is *queued*, not
 * delivered. The parent used to be told `Steered <name>.` unconditionally,
 * which read as "the model has seen this" while the child was still running
 * its previous batch.
 *
 * The first cut of this fix mapped the SDK's `"handled"` to `"delivered"`,
 * which is exactly backwards: `handled` is the SDK's *interception* signal —
 * `_queueUserInput` returns it before `_queueSteer` runs
 * (`dist/core/agent-session.js:1694-1697`; `dist/modes/rpc/rpc-client.js:133`:
 * "If the disposition is 'handled', no run started for this prompt"), i.e. an
 * input handler swallowed the text and the child never saw it. The receipt now
 * has three honest shapes — `queued`, `accepted`, `intercepted` — and no
 * `delivered` at all: no seam observes the model reading the text.
 *
 * Three layers are pinned here:
 *   1. `steerReceipt` — the three exact strings (the only place a receipt is
 *      built), including the negative pin that `intercepted` never renders as a
 *      success and `queued` never reads as delivery.
 *   2. `toSteerDisposition` — the SDK vocabulary (`"handled" | "queued" |
 *      undefined | junk`) onto the three dispositions, for both the steer and
 *      the prompt route.
 *   3. `steerChild` — the end-to-end wiring: whatever the orchestrator reports
 *      reaches the caller's text, and the orchestrator really got the message.
 *
 * `steerChild` is exported from index.ts for exactly this: driving it with a
 * plain-object `ChildContext` stub (the `ChildContext` type is private, so the
 * stub is cast through `Parameters<typeof steerChild>[0]`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	STEER_INTERCEPTED_NOTE,
	STEER_QUEUED_NOTE,
	steerChild,
	steerReceipt,
} from "../../index.ts";
import {
	toSteerDisposition,
	type SteerDisposition,
} from "../../src/supervisor/types.ts";

/** The one wording a queued steer may produce (em dash, no trailing period). */
const QUEUED_RECEIPT = `Steered worker-0 (${STEER_QUEUED_NOTE})`;
const ACCEPTED_RECEIPT = "Steered worker-0 (a turn was started with it)";
const INTERCEPTED_RECEIPT = `Steer worker-0 was ${STEER_INTERCEPTED_NOTE}`;

type SteerCtx = Parameters<typeof steerChild>[0];

function text(result: { content?: unknown }): string {
	return (result.content as Array<{ text?: string }>)
		.map((c) => c.text ?? "")
		.join("\n");
}

/**
 * A stub `ChildContext` with just the members `steerChild` touches: the
 * message, the orchestrator's `steer`, the child name, and the `followChild`
 * wiring (`found`, `agents`, `store`, and a runtime that accepts `track`/`watch`
 * without keeping state — `followChild` only needs the child to become
 * watchable, and this test is about the receipt, not the watch).
 */
function ctxFor(disposition: SteerDisposition, steers: Array<{ name: string; text: string }>): SteerCtx {
	return {
		action: "steer",
		params: { action: "steer", name: "worker-0", message: "use the other API" },
		name: "worker-0",
		orchestrator: {
			steer: async (name: string, message: string) => {
				steers.push({ name, text: message });
				return disposition;
			},
			childrenSnapshot: () => [],
		},
		runtime: {
			get: () => undefined,
			track: () => {},
			watch: () => {},
		},
		found: {
			runId: "r-1",
			child: { agent: "worker", sessionFile: "/tmp/worker-0.jsonl" },
		},
		agents: [],
		allAgents: [],
		store: {},
	} as unknown as SteerCtx;
}

test("steerReceipt: queued names the tool-batch delay instead of claiming delivery", () => {
	assert.match(
		steerReceipt("worker-0", "queued"),
		/^Steered worker-0 \(queued — it takes effect after its current tool batch finishes\)$/,
	);
	// One constant, shared with the revive/continue branch — not a second copy.
	assert.equal(steerReceipt("worker-0", "queued"), QUEUED_RECEIPT);
	assert.equal(STEER_QUEUED_NOTE, "queued — it takes effect after its current tool batch finishes");
});

test("steerReceipt: accepted says a turn was started, not that the model read it", () => {
	assert.equal(steerReceipt("worker-0", "accepted"), ACCEPTED_RECEIPT);
	// "Started a turn" is a weaker claim than "delivered": it says nothing about
	// the model having consumed the text.
	assert.ok(
		!steerReceipt("worker-0", "accepted").includes("Delivered"),
		"accepted receipt must not claim delivery",
	);
});

test("steerReceipt: intercepted never renders as a steered success", () => {
	const receipt = steerReceipt("worker-0", "intercepted");
	assert.equal(receipt, INTERCEPTED_RECEIPT);
	assert.equal(STEER_INTERCEPTED_NOTE, "intercepted by an input handler — the child never saw it");
	// The negative pin the review asked for: when the text was swallowed by an
	// input handler, the receipt must not start with the success wording.
	assert.ok(!receipt.includes("Steered "), `intercepted receipt claimed a steer: ${receipt}`);
	assert.match(receipt, /never saw it/);
	// And all three are distinguishable, so a caller can never confuse them.
	assert.equal(new Set([QUEUED_RECEIPT, ACCEPTED_RECEIPT, INTERCEPTED_RECEIPT]).size, 3);
});

test("steerReceipt: queued is not an error, but it does not end like a delivery receipt", () => {
	const queued = steerReceipt("worker-0", "queued");
	// It must not read like a failure…
	assert.ok(!queued.includes("Delivered"));
	assert.ok(!/fail|error/i.test(queued), `queued receipt reads like an error: ${queued}`);
	// …and the trailing period is what marks plain success; queued keeps its
	// sentence open inside the parenthesis instead.
	assert.ok(!queued.endsWith("."), `queued receipt ends like a delivery receipt: ${queued}`);
});

test("toSteerDisposition: \"handled\" is interception, everything else is the honest default", () => {
	const cases: Array<[label: string, raw: unknown, route: "steer" | "prompt", expected: SteerDisposition]> = [
		// `handled` never means delivered: `_queueSteer` never ran.
		["sdk handled, steer route", "handled", "steer", "intercepted"],
		["sdk handled, prompt route", "handled", "prompt", "intercepted"],
		// A steer that was not intercepted went into the queue.
		["sdk queued, steer route", "queued", "steer", "queued"],
		["older sdk returns nothing, steer route", undefined, "steer", "queued"],
		["junk string, steer route", "nonsense", "steer", "queued"],
		["junk number, steer route", 42, "steer", "queued"],
		// A prompt that did not say `handled` started a turn: that is `accepted`.
		["sdk queued, prompt route", "queued", "prompt", "accepted"],
		["older sdk returns nothing, prompt route", undefined, "prompt", "accepted"],
		["junk number, prompt route", 42, "prompt", "accepted"],
	];
	for (const [label, raw, route, expected] of cases) {
		assert.equal(toSteerDisposition(raw, route), expected, `toSteerDisposition(${label})`);
	}
	// The mapping can never produce a delivery claim.
	const outputs = cases.map(([, raw, route]) => toSteerDisposition(raw, route));
	assert.ok(!outputs.includes("delivered" as SteerDisposition));
});

test("steerChild: a queued disposition renders the queued receipt and reaches the orchestrator", async () => {
	const steers: Array<{ name: string; text: string }> = [];
	const result = await steerChild(ctxFor("queued", steers));

	assert.equal(text(result), QUEUED_RECEIPT);
	// The stub must have actually been called — otherwise the assertion above
	// could pass against a `steer` that never ran.
	assert.deepEqual(steers, [{ name: "worker-0", text: "use the other API" }]);
});

test("steerChild: an accepted disposition renders the accepted receipt and reaches the orchestrator", async () => {
	const steers: Array<{ name: string; text: string }> = [];
	const result = await steerChild(ctxFor("accepted", steers));

	assert.equal(text(result), ACCEPTED_RECEIPT);
	assert.deepEqual(steers, [{ name: "worker-0", text: "use the other API" }]);
});

test("steerChild: an intercepted disposition tells the parent the child never saw it", async () => {
	const steers: Array<{ name: string; text: string }> = [];
	const result = await steerChild(ctxFor("intercepted", steers));

	assert.equal(text(result), INTERCEPTED_RECEIPT);
	assert.ok(!text(result).includes("Steered "), "an intercepted steer must not read as a success");
	assert.deepEqual(steers, [{ name: "worker-0", text: "use the other API" }]);
});
