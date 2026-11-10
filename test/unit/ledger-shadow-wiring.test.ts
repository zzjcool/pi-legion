/**
 * P3 wiring (`docs/contracts/result-ledger-v1.md` §3 D11, v1.7): the two halves of
 * "the shadow can actually see a ledger in a real session".
 *
 * The sibling files pin the pure comparison (`ledger-shadow.test.ts`) and the
 * delivery seam's use of the facts (`runtime.test.ts`). This one pins the joint
 * between them, because a shadow that never receives a ledger handle is INERT: it
 * writes nothing, reports nothing, and looks exactly like a healthy run — the
 * failure mode D11 was written to make impossible.
 *
 * 1. **the extension hands the runtime a handle**: `index.ts`'s
 *    `createSessionRuntime({…})` deps carry `getLedgerShadowFacts`, answered from
 *    `ownLegionIdentity()` — the connection the entry already owns. No
 *    `openLegionDb`, no second connection to the same file, no env check of its
 *    own (the switch is the runtime's), and `undefined` when there is no identity.
 * 2. **the runtime only asks when the flag says so**: with
 *    `PI_LEGION_LEDGER_SHADOW` unset the hook is never CALLED, so the wiring above
 *    cannot open, query or allocate anything on the default path (默认零开销).
 *
 * Together: delete the wiring and (1) goes red; make the hook unconditional and
 * (2) goes red.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
	createSessionRuntime,
	type CollectSnapshot,
} from "../../src/extension/runtime.ts";
import { SHADOW_ENV } from "../../src/extension/ledger-shadow.ts";

function snapshot(): CollectSnapshot {
	return {
		execution: { status: "success" },
		output: "ok",
		acceptance: { status: "accepted", level: "attested" },
	};
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > 1_000) throw new Error(`timeout: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

// ───────────── 1. the production entry passes the hook — and only a handle ─────────────

test("D11 wiring: index.ts hands the runtime the ledger handle and the consumer id", () => {
	const source = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
	// Whitespace-insensitive: the assertion is about the wiring, not about wrapping.
	const flat = source.replace(/\s+/g, " ");

	const runtimeAt = flat.indexOf("const runtime = createSessionRuntime({");
	assert.ok(runtimeAt >= 0, "the extension still builds the session runtime at the expected place");
	const hookAt = flat.indexOf("getLedgerShadowFacts:");
	assert.ok(hookAt > runtimeAt, "the hook is passed INSIDE the createSessionRuntime deps, not somewhere else");
	assert.equal(
		flat.split("getLedgerShadowFacts").length - 1,
		1,
		"exactly one wiring point (a second one could shadow the first)",
	);

	// The shape that matters: the SAME identity supplies the handle and the consumer id,
	// and "no identity" answers undefined (the shadow then skips instead of guessing).
	assert.match(
		flat.slice(hookAt),
		/^getLedgerShadowFacts: \(\) => \{ const (\w+) = ownLegionIdentity\(\); return \1 \? \{ db: \1\.db, consumerId: \1\.nodeId \} : undefined; \},/,
		"the hook reuses ownLegionIdentity()'s existing handle — no second connection, no guessed consumer",
	);

	// A diagnostic may not open a handle of its own, and may not read the shadow flag
	// (that decision lives in exactly one place: `shadowEnabled`).
	const hookWindow = flat.slice(hookAt, hookAt + 200);
	assert.doesNotMatch(hookWindow, /openLegionDb|new Database|legionDbPath/);
	assert.doesNotMatch(hookWindow, new RegExp(SHADOW_ENV));
});

// ───────────── 2. …and asks for it only when the shadow is switched on ─────────────

test("默认零开销: with the flag off the runtime never asks the host for ledger facts", async () => {
	const previous = process.env[SHADOW_ENV];
	const messages: unknown[] = [];
	let asked = 0;
	delete process.env[SHADOW_ENV];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message);
		},
		// Deliberately answers `undefined`: this case is about WHETHER the hook is
		// called, not about what a ledger would say.
		getLedgerShadowFacts: () => {
			asked += 1;
			return undefined;
		},
	});
	try {
		runtime.setJoinConfig({ mode: "each", flushMs: 10_000 });
		const deliver = async (name: string): Promise<void> => {
			const before = messages.length;
			runtime.track({
				name,
				runId: "r-1",
				agent: "worker",
				sessionFile: `/tmp/${name}.jsonl`,
				timeoutMs: 1_000,
				collect: async () => snapshot(),
			});
			runtime.watch(name);
			await waitFor(() => messages.length > before, `${name} is delivered`);
		};

		await deliver("shadow-off");
		assert.equal(asked, 0, "the flag is off: the hook is not even called (no db lookup, not even undefined)");

		// Positive control: the hook IS reachable — so the zero above is the flag, not a
		// wiring that never fires.
		process.env[SHADOW_ENV] = "1";
		await deliver("shadow-on");
		assert.equal(asked, 1, "the flag is on: the seam asks, and an undefined answer keeps it silent");
	} finally {
		runtime.dispose();
		if (previous === undefined) delete process.env[SHADOW_ENV];
		else process.env[SHADOW_ENV] = previous;
	}
});
