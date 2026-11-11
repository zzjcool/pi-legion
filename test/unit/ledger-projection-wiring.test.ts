/**
 * P4c wiring (`docs/contracts/result-ledger-v1.md` §3 D4): the one seam that makes
 * the delivery projection exist in a real session.
 *
 * The claim model is gone, so `deps.getLedgerProjection` (renamed from P3's
 * `getLedgerShadowFacts`, whose comparison was deleted with the shadow) is no longer a
 * diagnostic input — it is the ONLY source of the "does this result still owe the parent
 * a notice" answer. A hook that is never wired therefore makes every notice decision
 * fall back to `deliveredOnce`, which is the degraded-but-alive path: nothing is lost,
 * but the ledger stops being able to settle anything, and that failure is invisible.
 * Hence this file.
 *
 * 1. **the extension hands the runtime a handle**: `index.ts`'s
 *    `createSessionRuntime({…})` deps carry `getLedgerProjection`, answered from
 *    `ownLegionIdentity()` — the connection the entry already owns. No `openLegionDb`,
 *    no second connection to the same file, no env check of its own, and `undefined`
 *    when there is no identity.
 * 2. **an unanswered hook is `undefined`, never a guess**: the runtime asks on every
 *    delivery decision, and "no identity" must read as "no projection" — the notice is
 *    then delivered (宁多推一条，不静默丢), which is the positive control below.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
	createSessionRuntime,
	type CollectSnapshot,
} from "../../src/extension/runtime.ts";

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

test("D4 wiring: index.ts hands the runtime the ledger handle and the consumer id", () => {
	const source = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
	// Whitespace-insensitive: the assertion is about the wiring, not about wrapping.
	const flat = source.replace(/\s+/g, " ");

	const runtimeAt = flat.indexOf("const runtime = createSessionRuntime({");
	assert.ok(runtimeAt >= 0, "the extension still builds the session runtime at the expected place");
	const hookAt = flat.indexOf("getLedgerProjection:");
	assert.ok(hookAt > runtimeAt, "the hook is passed INSIDE the createSessionRuntime deps, not somewhere else");
	assert.equal(
		flat.split("getLedgerProjection").length - 1,
		1,
		"exactly one wiring point (a second one could shadow the first)",
	);
	// P4c: the P3 name belonged to a comparison that no longer exists. A leftover would
	// be a hook the runtime never reads — i.e. silently no projection at all.
	assert.equal(
		flat.split("getLedgerShadowFacts").length - 1,
		0,
		"the shadow-era name is gone from the production wiring",
	);

	// The shape that matters: the SAME identity supplies the handle and the consumer id,
	// and "no identity" answers undefined (the runtime then degrades instead of guessing).
	assert.match(
		flat.slice(hookAt),
		/^getLedgerProjection: \(\) => \{ const (\w+) = ownLegionIdentity\(\); return \1 \? \{ db: \1\.db, consumerId: \1\.nodeId \} : undefined; \},/,
		"the hook reuses ownLegionIdentity()'s existing handle — no second connection, no guessed consumer",
	);

	// The projection may not open a handle of its own, and may not read an env switch:
	// there is one connection (the host's) and one source of truth.
	const hookWindow = flat.slice(hookAt, hookAt + 200);
	assert.doesNotMatch(hookWindow, /openLegionDb|new Database|legionDbPath/);
	assert.doesNotMatch(hookWindow, /PI_LEGION_LEDGER_SHADOW/);
});

// ───────────── 2. the hook is asked, and "no identity" degrades fail-open ─────────────

test("D4: the projection hook is asked on every delivery decision, and an undefined answer still delivers", async () => {
	const messages: unknown[] = [];
	let asked = 0;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message);
		},
		// Deliberately answers `undefined`: this case is about WHETHER the hook is
		// called and what an unanswered one means, not about what a ledger would say.
		getLedgerProjection: () => {
			asked += 1;
			return undefined;
		},
	});
	try {
		runtime.setJoinConfig({ mode: "each", flushMs: 10_000 });
		runtime.track({
			name: "no-identity",
			runId: "r-1",
			agent: "worker",
			sessionFile: "/tmp/no-identity.jsonl",
			timeoutMs: 1_000,
			collect: async () => snapshot(),
		});
		runtime.watch("no-identity");

		await waitFor(() => messages.length > 0, "the notice is delivered");
		assert.ok(asked >= 1, "the projection is consulted on the delivery path");
		assert.equal(
			messages.length,
			1,
			"no projection ⇒ nothing is known ⇒ the notice goes out (never a silent drop)",
		);
	} finally {
		runtime.dispose();
	}
});
