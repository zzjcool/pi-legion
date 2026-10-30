/**
 * #313: a steer receipt must not claim delivery it did not get.
 *
 * Pi delivers a steer after the child's current tool batch finishes and before
 * its next LLM call, so a message sent into a running tool is *queued*, not
 * delivered. The parent used to be told `Steered <name>.` unconditionally,
 * which read as "the model has seen this" while the child was still running
 * its previous batch.
 *
 * Three layers are pinned here:
 *   1. `steerReceipt` — the two exact strings (the only place a receipt is
 *      built), including the negative pin that `queued` never reads as delivery.
 *   2. `toSteerDisposition` — the SDK vocabulary (`"handled" | "queued" |
 *      undefined | junk`) onto the two dispositions. Anything doubtful is
 *      `"queued"`: a false queued understates, a false delivered lies.
 *   3. `steerChild` — the end-to-end wiring: whatever the orchestrator reports
 *      reaches the caller's text, and the orchestrator really got the message.
 *
 * `steerChild` is exported from index.ts for exactly this: driving it with a
 * plain-object `ChildContext` stub (the `ChildContext` type is private, so the
 * stub is cast through `Parameters<typeof steerChild>[0]`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { steerChild, steerReceipt } from "../../index.ts";
import { toSteerDisposition } from "../../src/supervisor/types.ts";

/** The one wording a queued steer may produce (em dash, no trailing period). */
const QUEUED_RECEIPT =
	"Steered worker-0 (queued — it takes effect after its current tool batch finishes)";

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
function ctxFor(disposition: "queued" | "delivered", steers: Array<{ name: string; text: string }>): SteerCtx {
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
	assert.equal(steerReceipt("worker-0", "queued"), QUEUED_RECEIPT);
});

test("steerReceipt: delivered keeps today's wording exactly", () => {
	assert.equal(steerReceipt("worker-0", "delivered"), "Steered worker-0.");
});

test("steerReceipt: the queued wording cannot be mistaken for the delivered one", () => {
	const queued = steerReceipt("worker-0", "queued");
	assert.notEqual(queued, steerReceipt("worker-0", "delivered"));
	// It is not an error and must not read like one, but it must not claim
	// delivery either — no capital-D "Delivered" anywhere in the queued text.
	assert.ok(!queued.includes("Delivered"), `queued receipt claimed delivery: ${queued}`);
	// And the trailing period is what marks plain delivery; queued must not carry it.
	assert.ok(!queued.endsWith("."), `queued receipt ends like a delivery receipt: ${queued}`);
});

test("toSteerDisposition: only \"handled\" means delivered, everything doubt-shaped is queued", () => {
	const cases: Array<[label: string, raw: unknown, expected: "queued" | "delivered"]> = [
		["sdk handled", "handled", "delivered"],
		["sdk queued", "queued", "queued"],
		["older sdk returns nothing", undefined, "queued"],
		["junk string", "nonsense", "queued"],
		["junk number", 42, "queued"],
	];
	for (const [label, raw, expected] of cases) {
		assert.equal(toSteerDisposition(raw), expected, `toSteerDisposition(${label})`);
	}
});

test("steerChild: a queued disposition renders the queued receipt and reaches the orchestrator", async () => {
	const steers: Array<{ name: string; text: string }> = [];
	const result = await steerChild(ctxFor("queued", steers));

	assert.equal(text(result), QUEUED_RECEIPT);
	// The stub must have actually been called — otherwise the assertion above
	// could pass against a `steer` that never ran.
	assert.deepEqual(steers, [{ name: "worker-0", text: "use the other API" }]);
});

test("steerChild: a delivered disposition renders the delivered receipt and reaches the orchestrator", async () => {
	const steers: Array<{ name: string; text: string }> = [];
	const result = await steerChild(ctxFor("delivered", steers));

	assert.equal(text(result), "Steered worker-0.");
	assert.deepEqual(steers, [{ name: "worker-0", text: "use the other API" }]);
});
