/**
 * #417 settle hold — the seven frozen rules, each pinned by a test that fails if the
 * rule is removed. `docs/reports/legion-hold.md` is the report; the policy lives in
 * `src/extension/hold.ts`, the outbox seam in `src/extension/runtime.ts`.
 *
 * The file has two halves on purpose:
 *
 * 1. **policy** (a fake runtime seam + a fake clock): the host awaits this boundary
 *    with no timeout, so "how long do we wait" and "what do we return" must be
 *    decidable without a host, a child, a timer or a ledger. That is also what makes
 *    the ten-minute budget testable at all — a real sleep would take ten minutes.
 * 2. **seam** (a real `createSessionRuntime` + a real `legion.db`): the `notified`
 *    latch is persistent by definition, so "a restart does not announce it again" can
 *    only be shown against the ledger, not against a fake.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
	HOLD_POLL_MS,
	createSettleHold,
	legionHoldMaxMs,
	type HoldChild,
	type HoldDraft,
	type HoldRecord,
	type TakenHoldNotice,
} from "../../src/extension/hold.ts";
import { SUBAGENT_NOTIFY_TYPE } from "../../src/extension/notify.ts";
import {
	SETTLE_FALLBACK_MS,
	createSessionRuntime,
	type CollectSnapshot,
	type SessionRuntime,
} from "../../src/extension/runtime.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { markRead, recordArtifact, undelivered } from "../../src/legion/ledger.ts";

// ─────────────────────────── 1. policy (fake seam) ───────────────────────────

const DRAFT: HoldDraft = {
	type: "custom_message",
	customType: SUBAGENT_NOTIFY_TYPE,
	content: "Background task completed: **worker-0 (worker)**",
	display: true,
	details: { status: "completed", name: "worker-0" },
};

/** One `custom_message` the host already had queued for this boundary. */
const EXISTING = {
	type: "custom_message" as const,
	customType: "another-extension",
	content: "queued before us",
	display: false,
};

interface Harness {
	hold: ReturnType<typeof createSettleHold>;
	records: HoldRecord[];
	/** Every wait the hold asked for, in order. */
	sleeps: number[];
	/** How many times each seam member was called. */
	calls: { take: number; commit: number; release: number; owns: number; returns: number };
	/** Seam calls AND trace events, in the order they happened (#418's ORDER pins read this). */
	order: string[];
	setChildren(children: HoldChild[]): void;
	setPending(pending: boolean): void;
	/** Fire the lone-ESC channel the hold subscribed to (when the ctx has one). */
	pressEsc(): void;
	/** The TUI ctx slice this harness hands to the hold. */
	ctx: Record<string, unknown>;
}

function harness(
	opts: {
		children?: HoldChild[];
		/** The seam itself is unavailable (a host that supplies no live-child reader). */
		degraded?: boolean;
		holdMaxMs?: number;
		pollMs?: number;
		pending?: boolean;
		/** Answer `takeNotice()` with nothing owed (every member already claimed). */
		nothingOwed?: boolean;
		/** Called at the START of every fake sleep, before the clock advances. */
		onSleep?: (h: Harness, index: number) => void;
	} = {},
): Harness {
	let clock = 10_000;
	let children: HoldChild[] | undefined = opts.children ?? [{ name: "worker-0", round: 1 }];
	let pending = opts.pending ?? false;
	let esc: (() => void) | undefined;
	const records: HoldRecord[] = [];
	const sleeps: number[] = [];
	const order: string[] = [];
	const calls = { take: 0, commit: 0, release: 0, owns: 0, returns: 0 };
	const ctx: Record<string, unknown> = {
		mode: "tui",
		hasPendingMessages: () => pending,
		ui: {
			onTerminalInput(handler: (data: string) => undefined) {
				esc = () => void handler("\x1b");
				return () => {
					esc = undefined;
				};
			},
		},
	};
	const state: Harness = {
		ctx,
		hold: undefined as never,
		records,
		sleeps,
		calls,
		order,
		setChildren(next) {
			children = next;
		},
		setPending(next) {
			pending = next;
		},
		pressEsc() {
			esc?.();
		},
	};
	state.hold = createSettleHold({
		liveChildren: () => (opts.degraded === true ? undefined : children),
		takeNotice: (): TakenHoldNotice | undefined => {
			calls.take += 1;
			order.push("take");
			if (opts.nothingOwed === true) return undefined;
			return { drafts: [DRAFT], content: DRAFT.content } satisfies TakenHoldNotice;
		},
		commitNotice: () => {
			calls.commit += 1;
			order.push("commit");
		},
		releaseNotice: () => {
			calls.release += 1;
			order.push("release");
		},
		ownsBoundary: () => {
			calls.owns += 1;
			order.push("owns");
		},
		returnsBoundary: () => {
			calls.returns += 1;
			order.push("returns");
		},
		holdMaxMs: opts.holdMaxMs ?? legionHoldMaxMs,
		pollMs: opts.pollMs ?? 100,
		now: () => clock,
		// The fake clock IS the schedule: a sleep advances time and can drive the child
		// set, the user queue or the Esc channel from inside the wait, which is what makes
		// every exit reachable in one tick.
		sleep: async (ms) => {
			sleeps.push(ms);
			opts.onSleep?.(state, sleeps.length - 1);
			clock += ms;
		},
		record: (record) => {
			records.push(record);
			order.push(record.ev);
		},
	});
	return state;
}

test("rule 4: the budget is the frozen ten minutes, and the poll stays bounded", () => {
	assert.equal(legionHoldMaxMs, 600_000);
	assert.ok(HOLD_POLL_MS > 0 && HOLD_POLL_MS <= 1_000, "a poll longer than a second is a user-visible stall");
});

test("rule 4: at the budget the hold stops waiting, does NOT continue, and records the truth", async () => {
	// The child never settles: only the budget can end this hold.
	// 1050 is deliberately NOT a multiple of the poll: with a clean multiple an unclamped
	// `sleep(pollMs)` still sums to the budget, so the assertion could not fail.
	const h = harness({ holdMaxMs: 1_050, pollMs: 100 });
	const result = await h.hold.beforeSettle({ entries: [], outcome: "completed" }, h.ctx);

	assert.equal(result, undefined, "a spent budget settles the turn exactly as without the hold");
	assert.equal(h.calls.commit, 0, "nothing to commit: no notice was taken");
	assert.equal(h.calls.take, 0);
	// Never sleeps past the deadline: the whole cost is holdMaxMs + at most one poll.
	assert.equal(
		h.sleeps.reduce((sum, ms) => sum + ms, 0),
		1_050,
		`the hold waits exactly its budget (slept ${h.sleeps.join("+")})`,
	);
	assert.equal(h.sleeps.at(-1), 50, "the last wait is clamped to what is left of the budget");
	assert.ok(h.sleeps.every((ms) => ms <= 100), "no single sleep overshoots the poll");
	const end = h.records.filter((record) => record.ev === "hold:end").at(-1);
	assert.equal(end?.outcome, "timeout");
	assert.equal(end?.heldMs, 1_050);
	assert.equal(end?.entriesOut, 0);
});

test("rule 3: the drafts are returned AFTER event.entries, which are spread verbatim", async () => {
	// Second probe sees no live child: the batch settled while we waited.
	const h = harness({
		children: [{ name: "worker-0", round: 1 }],
		onSleep: (state, index) => {
			if (index === 0) state.setChildren([]);
		},
	});
	const event = { entries: [EXISTING], outcome: "completed" };
	const result = await h.hold.beforeSettle(event, h.ctx);

	assert.ok(result, "all children settled: the boundary must carry the notice");
	assert.equal(result.continue, true);
	assert.equal(result.entries.length, 2, "the host's own entry survives next to ours");
	assert.equal(result.entries[0], EXISTING, "the spread is by identity: the host's draft object is reused");
	assert.deepEqual(result.entries[1], DRAFT);
	assert.equal(h.calls.commit, 1, "a delivered notice persists its latch");
	assert.equal(h.calls.release, 0, "a delivered notice is never released");
	assert.equal(h.calls.owns, 1, "the boundary owner cancels the settle rescue timer");

	const end = h.records.filter((record) => record.ev === "hold:end").at(-1);
	assert.equal(end?.outcome, "completed");
	assert.equal(end?.entriesIn, 1);
	assert.equal(end?.entriesOut, 2);
	assert.equal(end?.noticeChars, DRAFT.content.length);
	// ORDER: the latch is written before the entries leave this function.
	const commitAt = h.records.findIndex((record) => record.ev === "hold:commit");
	const endAt = h.records.findIndex((record) => record.ev === "hold:end");
	assert.ok(commitAt >= 0 && commitAt < endAt, "commit precedes the returning boundary");
});

test("rule 3: the module has exactly ONE `entries` return shape, and it is the spread", () => {
	// Structural guard: the host REPLACES `entries`, so a future edit that hands back
	// `[draft]` would silently erase another extension's queue (hold-spike.md §1 case 1d).
	const source = readFileSync(new URL("../../src/extension/hold.ts", import.meta.url), "utf8");
	// Comment lines are dropped: the doc block QUOTES the canonical host example, and a
	// quoted example is not a return shape.
	const code = source
		.split("\n")
		.filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
		.join("\n");
	const returns = [...code.matchAll(/entries:\s*([^\n]+),\n/g)].map((match) => match[1]!.trim());
	assert.deepEqual(returns, ["[...(entriesIn as HoldDraft[]), ...taken.drafts]"], `entries returns: ${returns.join(" | ")}`);
});

test("rule 5: `completed-empty` (nothing owed) releases, commits nothing and does not continue", async () => {
	// Reachable in production: the parent read the result through `collect`/`wait` while
	// the hold was waiting, so the projection stops owing the notice. A commit here would
	// latch a notice that was never announced.
	const h = harness({
		nothingOwed: true,
		onSleep: (state, index) => {
			if (index === 0) state.setChildren([]);
		},
	});
	assert.equal(await h.hold.beforeSettle({ entries: [EXISTING], outcome: "completed" }, h.ctx), undefined);
	assert.equal(h.calls.take, 1);
	assert.equal(h.calls.commit, 0, "no notice was delivered, so no latch may be written");
	assert.equal(h.calls.release, 1, "the release still runs first");
	assert.equal(h.records.at(-1)?.outcome, "completed-empty");
	assert.equal(h.records.at(-1)?.entriesOut, 0);
});

test("rule 5: a non-delivery exit releases BEFORE it returns, and never commits", async () => {
	const h = harness({ holdMaxMs: 300, pollMs: 100 });
	const result = await h.hold.beforeSettle({ entries: [], outcome: "completed" }, h.ctx);
	assert.equal(result, undefined);
	assert.equal(h.calls.commit, 0);
	assert.equal(h.calls.release, 1, "the held notice goes back to the followUp path");
	const releaseAt = h.records.findIndex((record) => record.ev === "hold:release");
	const endAt = h.records.findIndex((record) => record.ev === "hold:end");
	assert.ok(releaseAt >= 0, "the release is recorded");
	assert.ok(releaseAt < endAt, `release must precede the returning boundary (release@${releaseAt}, end@${endAt})`);
	assert.equal(h.records[endAt]?.outcome, "timeout");
});

test("rule 6: Esc during the hold is a CANCEL — no notification, no drafts, a distinct verdict", async () => {
	const h = harness({
		holdMaxMs: 100_000,
		pollMs: 100,
		onSleep: (state, index) => {
			if (index === 1) state.pressEsc();
		},
	});
	const result = await h.hold.beforeSettle({ entries: [EXISTING], outcome: "completed" }, h.ctx);

	assert.equal(result, undefined, "a cancelled turn must not announce anything");
	assert.equal(h.calls.take, 0, "the outbox was never touched");
	assert.equal(h.calls.commit, 0, "no latch: the notice is still owed and can be delivered later");
	assert.equal(h.calls.release, 1);
	const end = h.records.filter((record) => record.ev === "hold:end").at(-1);
	assert.equal(end?.outcome, "cancelled", "the cancel verdict is distinguishable from completed");
	assert.equal(end?.entriesOut, 0);
	assert.ok((end?.heldMs ?? Number.POSITIVE_INFINITY) < 1_000, "Esc ends the hold immediately, not at the budget");
});

test("rule 6: Esc in the SAME poll that the last child settles still cancels", async () => {
	// The child set empties and the user presses Esc before the loop looks again. The
	// post-sleep `interrupted` check is the only thing between the two; without it the
	// boundary would take the notice and return drafts AFTER the abort — an announcement
	// plus an orphan draft, the exact pair rule 6 forbids.
	const h = harness({
		holdMaxMs: 100_000,
		pollMs: 100,
		onSleep: (state) => {
			state.setChildren([]);
			state.pressEsc();
		},
	});
	assert.equal(await h.hold.beforeSettle({ entries: [EXISTING], outcome: "completed" }, h.ctx), undefined);
	assert.equal(h.calls.take, 0, "a cancelled turn must not even look at the outbox");
	assert.equal(h.calls.commit, 0);
	assert.equal(h.records.at(-1)?.outcome, "cancelled");
});

test("rule 6: a run the host already aborted is a cancel at ENTRY, with zero waiting", async () => {
	const h = harness();
	for (const outcome of ["aborted", "error"]) {
		assert.equal(await h.hold.beforeSettle({ entries: [EXISTING], outcome }, h.ctx), undefined);
	}
	assert.equal(h.sleeps.length, 0, "an aborted run never waits");
	assert.equal(h.calls.commit, 0);
	assert.equal(h.calls.take, 0, "no notice is taken for an aborted run (that is the orphan draft)");
	assert.equal(h.records.at(-1)?.outcome, "cancelled");
});

test("rule 7: a queued USER message is never blocked — not at entry and not mid-hold", async () => {
	const atEntry = harness({ pending: true });
	assert.equal(await atEntry.hold.beforeSettle({ entries: [], outcome: "completed" }, atEntry.ctx), undefined);
	assert.equal(atEntry.sleeps.length, 0, "the user path does not wait even one poll");
	assert.equal(atEntry.records.at(-1)?.outcome, "user-waiting");

	// The user types while the hold is running: at most one poll of delay.
	const midHold = harness({
		holdMaxMs: 100_000,
		pollMs: 100,
		onSleep: (state, index) => {
			if (index === 0) state.setPending(true);
		},
	});
	assert.equal(await midHold.hold.beforeSettle({ entries: [], outcome: "completed" }, midHold.ctx), undefined);
	assert.equal(midHold.sleeps.length, 1, "the queue is noticed on the next poll, not later");
	assert.equal(midHold.records.at(-1)?.outcome, "user-waiting");
	assert.equal(midHold.calls.commit, 0);
});

/** index.ts with comment lines dropped: the pins below are about CODE, not prose. */
function productionCode(): string {
	const source = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
	return source
		.split("\n")
		.filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
		.join("\n");
}

test("rule 1: exactly ONE `agent_before_settle` registration, and NO `turn_end` handler", () => {
	// Without this pin the whole feature can be unplugged (or a second boundary owner
	// added) with a green suite — the host is the only place the chain exists, so the
	// wiring itself has to be asserted. Precedent: ledger-projection-wiring.test.ts.
	const code = productionCode();
	const settle = [...code.matchAll(/pi\.on\(\s*"agent_before_settle"/g)];
	assert.equal(settle.length, 1, "a second registrant would cancel or delete this hold's drafts");
	assert.match(
		code,
		/pi\.on\("agent_before_settle", \(event, ctx\) => settleHold\.beforeSettle\(event, ctx\)\)/,
		"the one registration is the hold's handler",
	);
	assert.equal(
		[...code.matchAll(/pi\.on\(\s*"turn_end"/g)].length,
		0,
		"`turn_end` stays unregistered (see the block comment in index.ts)",
	);
	// #418: the pair must be wired together. A hold that claims the boundary and never hands
	// it back is exactly the gap this pin closes; `ownsBoundary` without `returnsBoundary`
	// leaves the settle window with no rescue at all, and nothing else would notice.
	assert.match(code, /ownsBoundary: \(\) => runtime\.holdOwnsBoundary\?\.\(\)/);
	assert.match(
		code,
		/returnsBoundary: \(\) => runtime\.holdReturnsBoundary\?\.\(\)/,
		"the hold's hand-back is wired to the very runtime that armed the rescue",
	);
});

test("rule 1: no hold in print/json/rpc, and none inside a legion child", async () => {
	for (const mode of ["print", "json", "rpc", undefined]) {
		const h = harness();
		const result = await h.hold.beforeSettle({ entries: [], outcome: "completed" }, { mode });
		assert.equal(result, undefined, `mode ${String(mode)} must not hold`);
		assert.equal(h.sleeps.length, 0);
		assert.equal(h.records.at(-1)?.outcome, "mode");
	}

	// The nested gate (#417 D4): a child never parks its own parent's boundary.
	const previous = process.env.PI_LEGION_NODE_ID;
	process.env.PI_LEGION_NODE_ID = "root.worker";
	try {
		const h = harness();
			assert.equal(await h.hold.beforeSettle({ entries: [], outcome: "completed" }, h.ctx), undefined);
		assert.equal(h.sleeps.length, 0);
		assert.equal(h.records.at(-1)?.outcome, "nested");
	} finally {
		if (previous === undefined) delete process.env.PI_LEGION_NODE_ID;
		else process.env.PI_LEGION_NODE_ID = previous;
	}
});

test("rule 1: an idle or degraded boundary costs nothing — no poll, no seam call", async () => {
	const idle = harness({ children: [] });
	assert.equal(await idle.hold.beforeSettle({ entries: [EXISTING], outcome: "completed" }, idle.ctx), undefined);
	assert.equal(idle.sleeps.length, 0);
	assert.deepEqual(idle.calls, { take: 0, commit: 0, release: 0, owns: 0, returns: 0 });
	assert.equal(idle.records.at(-1)?.outcome, "idle");

	// A degraded seam abstains too: a wrong list would either park the turn for nothing or
	// ask the host to continue with no new context.
	const degraded = harness({ degraded: true });
	assert.equal(await degraded.hold.beforeSettle({ entries: [], outcome: "completed" }, degraded.ctx), undefined);
	assert.equal(degraded.sleeps.length, 0);
	assert.equal(degraded.records.at(-1)?.outcome, "degraded");
	assert.equal(degraded.calls.owns, 0);
	assert.equal(degraded.calls.returns, 0, "a boundary the hold never took has nothing to hand back");
});

test("rule 4 (R3): the same still-running set cannot burn a second budget", async () => {
	const h = harness({ holdMaxMs: 200, pollMs: 100 });
	assert.equal(await h.hold.beforeSettle({ entries: [], outcome: "completed" }, h.ctx), undefined);
	assert.equal(h.sleeps.length, 2);
	// Same children, next boundary: abstain immediately. Re-arming a per-run latch on
	// `agent_start` is exactly the 278-hops-in-60s bug from hold-spike.md §1.3.
	assert.equal(await h.hold.beforeSettle({ entries: [], outcome: "completed" }, h.ctx), undefined);
	assert.equal(h.sleeps.length, 2, "no second wait for a set that already gave up");
	assert.equal(h.records.at(-1)?.outcome, "already-gave-up");
	// A NEW child re-arms the hold — the gate is the child set, not a run counter.
	h.setChildren([
		{ name: "worker-0", round: 1 },
		{ name: "worker-1", round: 1 },
	]);
	h.calls.owns = 0; // the first hold claimed the boundary once; count the re-arm only
	assert.equal(await h.hold.beforeSettle({ entries: [], outcome: "completed" }, h.ctx), undefined);
	assert.equal(h.calls.owns, 1, "a new dispatch is a new reason to hold");
});

test("rule 2: no exit ever returns `continue: false`", async () => {
	// Behavioural: every reachable exit, enumerated. None may answer the host with the
	// field that cancels another holder's continuation and commits its drafts.
	const exits: Array<() => Promise<unknown>> = [
		// Each exit drives ITS OWN harness: the ctx and the seam must belong together, or
		// the Esc / user-queue exit cannot fire and the entry proves nothing.
		() => {
			const h = harness({ onSleep: (state) => state.setChildren([]) });
			return h.hold.beforeSettle({ entries: [], outcome: "completed" }, h.ctx);
		},
		() => {
			const h = harness({ pending: true });
			return h.hold.beforeSettle({}, h.ctx);
		},
		() => {
			const h = harness({ holdMaxMs: 100, pollMs: 50 });
			return h.hold.beforeSettle({}, h.ctx);
		},
		() => {
			const h = harness({ nothingOwed: true, onSleep: (state) => state.setChildren([]) });
			return h.hold.beforeSettle({}, h.ctx);
		},
		() => {
			const h = harness({ onSleep: (state) => state.pressEsc() });
			return h.hold.beforeSettle({}, h.ctx);
		},
		() => {
			const h = harness({ degraded: true });
			return h.hold.beforeSettle({}, h.ctx);
		},
		() => {
			const h = harness({ children: [] });
			return h.hold.beforeSettle({}, h.ctx);
		},
		() => {
			const h = harness();
			return h.hold.beforeSettle({ outcome: "aborted" }, h.ctx);
		},
		() => {
			const h = harness();
			return h.hold.beforeSettle({}, { mode: "print" });
		},
		() => {
			const h = harness({ children: [] });
			return h.hold.beforeSettle({}, undefined);
		},
	];
	for (const [index, run] of exits.entries()) {
		const result = (await run()) as { continue?: boolean } | undefined;
		assert.notEqual(result?.continue, false, `exit #${index} returned continue:false`);
	}
	// Structural: the field is never even spelled as a VALUE in the module's CODE (the doc
	// block names it on purpose, which is why comment lines are dropped first). String
	// literals are blanked too: the trace REASON quotes the host's field verbatim
	// (`hold skipped: peer continue:false`, #421), and a reason is not a return.
	const source = readFileSync(new URL("../../src/extension/hold.ts", import.meta.url), "utf8");
	const code = source
		.split("\n")
		.filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
		.join("\n")
		.replace(/"(?:[^"\\]|\\.)*"/g, '""')
		.replace(/`(?:[^`\\]|\\.)*`/g, '""');
	assert.doesNotMatch(code, /continue:\s*false/, "the module must not contain `continue: false`");
	const continuations = [...code.matchAll(/continue:\s*(\w+)/g)].map((match) => match[1]);
	assert.ok(continuations.length > 0, "the delivery exit does ask for one continuation");
	assert.deepEqual(
		[...new Set(continuations)],
		["true"],
		`the only continuation this module ever asks for is \`true\` (saw ${continuations.join(",")})`,
	);
});

test("a throwing seam settles the turn and hands the notice back", async () => {
	let released = 0;
	let probes = 0;
	const hold = createSettleHold({
		// Live on the entry probe, gone on the first poll: `takeNotice` is then reached and
		// throws, which is the failure this test is about (a constant clock plus a live
		// child would loop until the budget, i.e. forever in fake time).
		liveChildren: () => (probes++ === 0 ? [{ name: "worker-0", round: 1 }] : []),
		takeNotice: () => {
			throw new Error("outbox exploded");
		},
		commitNotice: () => undefined,
		releaseNotice: () => {
			released += 1;
		},
		pollMs: 10,
		now: () => 1,
		sleep: async () => undefined,
	});
	assert.equal(await hold.beforeSettle({}, harness().ctx), undefined, "a hold may never fail a turn");
	assert.equal(released, 1, "the release path still ran");
});

test("dispose(): a torn-down session stops holding", async () => {
	const h = harness();
	h.hold.dispose();
	assert.equal(await h.hold.beforeSettle({}, h.ctx), undefined);
	assert.equal(h.sleeps.length, 0);
	assert.equal(h.records.at(-1)?.outcome, "disposed");
});

// ────────────────── #418: handing the boundary back (fallback re-arm) ──────────────────

test("#418: every exit that claimed the boundary hands it back, and the abstains do not", async () => {
	// The rescue timer that `ownsBoundary` cancelled covers the window "the hold is over, the
	// host has not settled yet". EVERY exit from the owned region opens that window, so every
	// exit restores the timer — an abstain never claimed the boundary, so it restores nothing
	// (the timer was never cancelled, and arming one there would be a second rescue).
	const delivered = harness({
		onSleep: (state, index) => {
			if (index === 0) state.setChildren([]);
		},
	});
	assert.ok(await delivered.hold.beforeSettle({ entries: [], outcome: "completed" }, delivered.ctx));
	assert.equal(delivered.calls.owns, 1);
	assert.equal(delivered.calls.returns, 1, "a delivery hands the boundary back too: the outbox may hold more");

	const owned: Array<[string, Harness]> = [
		["timeout", harness({ holdMaxMs: 300, pollMs: 100 })],
		[
			"cancelled",
			harness({
				holdMaxMs: 100_000,
				pollMs: 100,
				onSleep: (state, index) => {
					if (index === 1) state.pressEsc();
				},
			}),
		],
		[
			"user-waiting",
			harness({
				holdMaxMs: 100_000,
				pollMs: 100,
				onSleep: (state, index) => {
					if (index === 0) state.setPending(true);
				},
			}),
		],
		[
			"completed-empty",
			harness({
				nothingOwed: true,
				onSleep: (state, index) => {
					if (index === 0) state.setChildren([]);
				},
			}),
		],
	];
	for (const [outcome, h] of owned) {
		assert.equal(await h.hold.beforeSettle({ entries: [], outcome: "completed" }, h.ctx), undefined);
		assert.equal(h.records.filter((record) => record.ev === "hold:end").at(-1)?.outcome, outcome);
		assert.equal(h.calls.owns, 1, `${outcome}: the hold did claim the boundary`);
		assert.equal(h.calls.returns, 1, `${outcome}: so the rescue has to be armed again`);
	}

	const abstains: Array<[string, Harness]> = [
		["idle", harness({ children: [] })],
		["degraded", harness({ degraded: true })],
	];
	for (const [outcome, h] of abstains) {
		assert.equal(await h.hold.beforeSettle({ entries: [], outcome: "completed" }, h.ctx), undefined);
		assert.equal(h.records.at(-1)?.outcome, outcome);
		assert.equal(h.calls.returns, 0, `${outcome}: nothing was claimed, so nothing is handed back`);
	}
	// A hold that never ran (print mode) must not arm a timer either.
	const noTui = harness();
	assert.equal(await noTui.hold.beforeSettle({ entries: [], outcome: "completed" }, { mode: "print" }), undefined);
	assert.equal(noTui.calls.returns, 0);
});

test("#418: the hand-back is the LAST thing the hold does — after the release, and after the drafts are final", async () => {
	// Ordering matters for one reason: a rescue that fires while the notice is still CLAIMED
	// would announce nothing (the outbox is empty at that instant), and a rescue that fires
	// before the drafts are returned would be a second delivery of the same boundary.
	const delivered = harness({
		onSleep: (state, index) => {
			if (index === 0) state.setChildren([]);
		},
	});
	await delivered.hold.beforeSettle({ entries: [], outcome: "completed" }, delivered.ctx);
	assert.deepEqual(delivered.order, ["owns", "hold:begin", "take", "commit", "hold:commit", "hold:end", "returns"]);

	const released = harness({ holdMaxMs: 300, pollMs: 100 });
	await released.hold.beforeSettle({ entries: [], outcome: "completed" }, released.ctx);
	assert.deepEqual(released.order, ["owns", "hold:begin", "release", "hold:release", "hold:end", "returns"]);
});

test("#418: a rescue seam that throws cannot fail the boundary", async () => {
	// `returnsBoundary` is a timer arm, not a delivery: if it explodes the hold must still
	// have settled the turn the way it promised (hold:end, not the error abstain).
	let clock = 0;
	const records: HoldRecord[] = [];
	const hold = createSettleHold({
		liveChildren: () => [{ name: "worker-0", round: 1 }],
		takeNotice: () => undefined,
		commitNotice: () => undefined,
		releaseNotice: () => undefined,
		ownsBoundary: () => undefined,
		returnsBoundary: () => {
			throw new Error("the rescue timer is unavailable");
		},
		holdMaxMs: 100,
		pollMs: 50,
		now: () => (clock += 100),
		sleep: async () => undefined,
		record: (record) => {
			records.push(record);
		},
	});
	assert.equal(await hold.beforeSettle({ entries: [], outcome: "completed" }, { mode: "tui" }), undefined);
	assert.equal(records.at(-1)?.ev, "hold:end", "the boundary settled; the throwing seam did not become the verdict");
	assert.equal(records.at(-1)?.outcome, "timeout");
});

// ────────────────── #421: the chain's continuation vote (peer veto) ──────────────────

test("#421: a handler BEFORE us that refused the continuation is not overwritten — the hold stands down", async () => {
	// On a host that expresses "nobody has spoken yet" (no field on the boundary), a `false`
	// can only be a handler's own answer. Continuing the turn anyway would overwrite the one
	// vote the chain holds, so the hold stands down: zero waiting, nothing taken (the notice
	// keeps waiting for the normal path), and the reason recorded instead of swallowed.
	const h = harness({ holdMaxMs: 100, pollMs: 50 });
	// First boundary: the host omits the field — that is what teaches the instance that this
	// host CAN say "nobody spoke".
	assert.equal(await h.hold.beforeSettle({ entries: [], outcome: "completed" }, h.ctx), undefined);
	assert.equal(h.records.at(-1)?.outcome, "timeout");
	assert.equal(h.records.at(-1)?.chainVote, "absent");
	const waited = h.sleeps.length;

	// Second boundary: a handler before us refused the continuation.
	const vetoed = await h.hold.beforeSettle({ entries: [EXISTING], outcome: "completed", continue: false }, h.ctx);
	assert.equal(vetoed, undefined, "legion must not continue a turn a peer refused to continue");
	const end = h.records.at(-1);
	assert.equal(end?.outcome, "peer-continue-false");
	assert.equal(end?.reason, "hold skipped: peer continue:false", "the reason is the diagnosable string");
	assert.equal(end?.chainVote, "veto");
	assert.equal(h.sleeps.length, waited, "a vetoed boundary waits ZERO polls");
	assert.equal(h.calls.take, 0, "nothing is taken: the notice goes through the normal path");
	assert.equal(h.calls.owns, 1, "and the boundary is never claimed, so the rescue timer was never cancelled");
});

test("#421: on a host whose \"nobody spoke\" value IS `false` (pi 1.5.2) the same boundary behaves exactly as before", async () => {
	// runner.js:770 starts the chain at `false` and :785-786 assigns each handler's answer
	// over it, so on 1.5.2 a prior handler's veto and an untouched chain are the SAME BYTE.
	// Reading that byte as a veto would switch the hold off for every user of the current
	// host, so it is recorded as `sentinel` and the boundary behaves as it did before #421.
	const control = harness({
		onSleep: (state, index) => {
			if (index === 0) state.setChildren([]);
		},
	});
	const controlResult = await control.hold.beforeSettle({ entries: [], outcome: "completed" }, control.ctx);

	const withFalse = harness({
		onSleep: (state, index) => {
			if (index === 0) state.setChildren([]);
		},
	});
	const falseResult = await withFalse.hold.beforeSettle(
		{ entries: [], outcome: "completed", continue: false },
		withFalse.ctx,
	);

	// Byte-identical: same seams in the same order, same waits, same answer.
	assert.deepEqual(withFalse.order, control.order);
	assert.deepEqual(withFalse.sleeps, control.sleeps);
	assert.deepEqual(falseResult, controlResult);
	assert.equal(falseResult?.continue, true);
	assert.equal(falseResult?.entries.length, 1);
	// The ONLY difference is what the trace says the chain had decided.
	assert.equal(control.records[0]?.chainVote, "absent");
	assert.equal(withFalse.records[0]?.chainVote, "sentinel");
});

test("#421: `continue: true` from an earlier handler is echoed, not invented", async () => {
	// A peer that already asked the host to continue makes our continuation a no-op, so the
	// hold may proceed — and the trace says which of the two it was.
	const h = harness({
		onSleep: (state, index) => {
			if (index === 0) state.setChildren([]);
		},
	});
	const result = await h.hold.beforeSettle({ entries: [], outcome: "completed", continue: true }, h.ctx);
	assert.equal(result?.continue, true);
	assert.equal(h.records[0]?.chainVote, "continue");
	assert.equal(h.calls.take, 1);
});

// ─────────────────────── 2. seam (real runtime + real ledger) ───────────────────────

const ARTIFACT_BYTES = 10;

function snapshotWith(artifactId: string): CollectSnapshot {
	return {
		execution: { status: "success" },
		output: "worker-0 output",
		acceptance: { status: "accepted", level: "attested" },
		artifactId,
	};
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > 2_000) throw new Error(`timeout: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/**
 * One watched child that then settles while the parent run is live — the ONE state the
 * hold exists for: `deliverBatch` queues the notice into the outbox instead of sending
 * it, and the boundary may announce it in-turn.
 */
async function settleOneChild(runtime: SessionRuntime, artifactId: string): Promise<void> {
	runtime.notifyParentRunStart();
	let resolve: ((snapshot: CollectSnapshot) => void) | undefined;
	runtime.track({
		name: "worker-0",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/worker-0.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((next) => {
				resolve = next;
			}),
	});
	assert.deepEqual(runtime.holdableChildren?.(), [], "a tracked but unwatched job cannot notify, so it is not held");
	runtime.watch("worker-0");
	assert.deepEqual(
		runtime.holdableChildren?.().map((child) => `${child.name}#${child.round}`),
		["worker-0#1"],
		"a watched, working child is exactly what the hold waits for",
	);
	resolve!(snapshotWith(artifactId));
	await waitFor(() => (runtime.holdableChildren?.().length ?? 0) === 0, "child settled");
}

function ledgerRuntime(sendMessage: (message: { content: string }) => void, db: ReturnType<typeof openLegionDb>) {
	return createSessionRuntime({
		sendMessage: sendMessage as never,
		getLedgerProjection: () => ({ db, consumerId: "root" }),
	});
}

function recordOneArtifact(
	db: ReturnType<typeof openLegionDb>,
	artifactId: string,
	name = "worker-0",
): void {
	recordArtifact(db, {
		id: artifactId,
		parentId: "root",
		nodeId: `root.${name}`,
		name,
		round: 1,
		path: `/tmp/r-1/artifacts/${name}/r1.md`,
		bytes: ARTIFACT_BYTES,
		createdAt: 1_000,
	});
}

test("rule 5: the persistent latch — a RESTART cannot announce the same result twice", async () => {
	const db = openLegionDb(":memory:");
	const sent: string[] = [];
	const artifactId = "r-1/worker-0/r1";
	recordOneArtifact(db, artifactId);

	// --- session 1: the hold announces the completion in-turn -------------------
	const first = ledgerRuntime((message) => sent.push(message.content), db);
	await settleOneChild(first, artifactId);
	assert.equal(first.noticeQueueStats().pending, 1, "the live parent run held the notice structurally");
	const taken = first.takeHeldNotice?.();
	assert.ok(taken, "the queued notice is what a boundary would announce");
	assert.match(taken.content, /Background task completed: \*\*worker-0 \(worker\)\*\*/);
	assert.equal(taken.drafts[0]?.customType, SUBAGENT_NOTIFY_TYPE);
	assert.equal(taken.drafts[0]?.type, "custom_message");
	assert.equal(taken.drafts[0]?.display, true, "a completion notice stays visible, exactly like the followUp copy");
	first.commitHeldNotice?.();
	// The ledger row is the latch: written once, and the artifact no longer owes a notice.
	assert.deepEqual(undelivered(db, "root").map((row) => row.id), [], "the notified latch is persisted");

	// The boundary settled with the notice already announced: nothing may be sent behind
	// it (that is the duplicate the followUp path would have produced).
	first.notifyParentSettled();
	assert.equal(sent.length, 0, "a committed notice is not sent again at the boundary");
	first.dispose();

	// --- session 2: a fresh runtime, the SAME ledger -----------------------------
	// A restart has no `deliveredOnce` memory at all; only the ledger can answer this.
	const second = ledgerRuntime((message) => sent.push(message.content), db);
	await settleOneChild(second, artifactId);
	assert.equal(second.noticeQueueStats().pending, 0, "the restarted session owes nothing for round 1");
	assert.equal(second.takeHeldNotice?.(), undefined, "no second announcement after a restart");
	second.notifyParentSettled();
	assert.equal(sent.length, 0);
	second.dispose();
	db.close();
});

test("rule 5: release hands the notice back — the normal followUp path still delivers it", async () => {
	const db = openLegionDb(":memory:");
	const sent: string[] = [];
	const artifactId = "r-1/worker-0/r1";
	recordOneArtifact(db, artifactId);
	const runtime = ledgerRuntime((message) => sent.push(message.content), db);
	await settleOneChild(runtime, artifactId);

	assert.ok(runtime.takeHeldNotice?.());
	runtime.releaseHeldNotice?.();
	// Released, so the queue is intact and the settlement delivers through the normal path.
	assert.equal(runtime.noticeQueueStats().pending, 1, "the released notice is still queued");
	assert.deepEqual(undelivered(db, "root").map((row) => row.id), [artifactId], "nothing was latched");
	runtime.notifyParentSettled();
	assert.equal(sent.length, 1, "the released notice is delivered by the followUp path");
	assert.match(sent[0]!, /Background task completed: \*\*worker-0 \(worker\)\*\*/);
	runtime.dispose();
	db.close();
});

test("the hold re-filters with the projection: a result claimed during the hold is not announced", async () => {
	// The outbox entry was queued while it still owed a notice; the parent then read the
	// artifact (`collect`/`wait`, or the read hook) before the boundary took it. Taking it
	// anyway would announce a result the parent already holds — the duplicate the
	// projection exists to prevent (D4).
	const db = openLegionDb(":memory:");
	const sent: string[] = [];
	const artifactId = "r-1/worker-0/r1";
	recordOneArtifact(db, artifactId);
	const runtime = ledgerRuntime((message) => sent.push(message.content), db);
	await settleOneChild(runtime, artifactId);
	assert.equal(runtime.noticeQueueStats().pending, 1);
	markRead(db, { artifactId, consumerId: "root", bytesRead: ARTIFACT_BYTES, at: 2_000 });
	assert.equal(runtime.takeHeldNotice?.(), undefined, "an already-read result is not taken");
	runtime.notifyParentSettled();
	assert.equal(sent.length, 0, "and it is not sent either");
	runtime.dispose();
	db.close();
});

test("the hold skips an outbox item that no longer owes a notice", async () => {
	// FIFO with dead weight at the head: the parent read round A's result while it waited,
	// and B's notice is behind it. Taking A would announce a result the parent already
	// holds (and drop B); a take that simply gives up on the first item would announce
	// nothing at all. `mode: "each"` is what puts two items in the queue.
	const db = openLegionDb(":memory:");
	const sent: string[] = [];
	recordOneArtifact(db, "r-1/worker-a/r1", "worker-a");
	recordOneArtifact(db, "r-1/worker-b/r1", "worker-b");
	const runtime = ledgerRuntime((message) => sent.push(message.content), db);
	runtime.setJoinConfig({ mode: "each", flushMs: 10_000 });
	runtime.notifyParentRunStart();
	const pending = new Map<string, (snapshot: CollectSnapshot) => void>();
	for (const name of ["worker-a", "worker-b"]) {
		runtime.track({
			name,
			runId: "r-1",
			agent: "worker",
			sessionFile: `/tmp/${name}.jsonl`,
			timeoutMs: 1_000,
			collect: () =>
				new Promise<CollectSnapshot>((next) => {
					pending.set(name, next);
				}),
		});
		runtime.watch(name);
	}
	pending.get("worker-a")!(snapshotWith("r-1/worker-a/r1"));
	await waitFor(() => runtime.noticeQueueStats().pending === 1, "a queued");
	pending.get("worker-b")!(snapshotWith("r-1/worker-b/r1"));
	await waitFor(() => runtime.noticeQueueStats().pending === 2, "both queued");
	markRead(db, { artifactId: "r-1/worker-a/r1", consumerId: "root", bytesRead: ARTIFACT_BYTES, at: 2_000 });
	assert.equal(runtime.noticeQueueStats().pending, 1, "A is settled, B is still owed");
	const taken = runtime.takeHeldNotice?.();
	assert.ok(taken, "the boundary still gets a notice");
	assert.match(taken.content, /worker-b/, "the live item, not the claimed one at the head");
	assert.doesNotMatch(taken.content, /worker-a/);
	runtime.dispose();
	db.close();
});

test("#418: a hold that hands the boundary back leaves the rescue armed — the notice arrives though the settle never does", async () => {
	// End-to-end through the PRODUCTION seams: the real hold policy drives the real outbox
	// against a real ledger, and the only injected piece is the host timer (a 2 s claim fired
	// by hand). What is under test is "somebody still arms it", not "setTimeout works" —
	// the real setTimeout variant is the test right below this one.
	const db = openLegionDb(":memory:");
	const artifactId = "r-1/worker-0/r1";
	recordOneArtifact(db, artifactId);
	const sent: string[] = [];
	const timers: Array<{ ms: number; fn: () => void; canceled: boolean }> = [];
	const runtime = createSessionRuntime({
		sendMessage: ((message: { content: string }) => sent.push(message.content)) as never,
		getLedgerProjection: () => ({ db, consumerId: "root" }),
		scheduleSettleFallback: (ms, fn) => {
			const slot = { ms, fn, canceled: false };
			timers.push(slot);
			return {
				cancel: () => {
					slot.canceled = true;
				},
			};
		},
	});
	await settleOneChild(runtime, artifactId);
	assert.equal(runtime.noticeQueueStats().pending, 1, "the live parent run holds the notice");

	// The parent's turn ended and `agent_settled` was never seen — the aborted/ESC shape.
	runtime.notifyParentRunEnd();
	assert.equal(timers.length, 1, "agent_end armed the rescue");

	// The hold claims the boundary, waits out its budget on a child that never settles (the
	// worst case: nothing is delivered, the notice is released) and hands the boundary back.
	const hold = createSettleHold({
		liveChildren: () => [{ name: "worker-0", round: 1 }],
		takeNotice: () => runtime.takeHeldNotice?.(),
		commitNotice: () => runtime.commitHeldNotice?.(),
		releaseNotice: () => runtime.releaseHeldNotice?.(),
		ownsBoundary: () => runtime.holdOwnsBoundary?.(),
		returnsBoundary: () => runtime.holdReturnsBoundary?.(),
		pollMs: 5,
		holdMaxMs: 15,
	});
	assert.equal(await hold.beforeSettle({ entries: [], outcome: "completed" }, { mode: "tui" }), undefined);
	assert.equal(timers[0]?.canceled, true, "the hold cancelled the rescue it took over from");
	assert.equal(timers.length, 2, "and the hand-back armed it again");
	assert.equal(timers[1]?.ms, SETTLE_FALLBACK_MS);
	assert.equal(sent.length, 0, "the hold itself delivered nothing");

	// The net the hold restored is what releases the notice now.
	timers[1]!.fn();
	assert.equal(sent.length, 1, "the notice the settle never delivered arrives anyway");
	assert.match(sent[0] ?? "", /Background task completed: \*\*worker-0 \(worker\)\*\*/);
	assert.equal(runtime.noticeQueueStats().pending, 0, "the outbox is drained");
	runtime.dispose();
	db.close();
});

test("#418 (real timer): the production rescue timer really fires after the hold hands the boundary back", async () => {
	// The same end-to-end with NOTHING injected: the runtime's own unref'd `setTimeout`
	// (`defaultNoticeOverflow`) and the frozen 2 s delay. This is the reproducible proof that
	// the re-arm is not a test-only seam.
	const db = openLegionDb(":memory:");
	const artifactId = "r-1/worker-0/r1";
	recordOneArtifact(db, artifactId);
	const sent: string[] = [];
	const runtime = ledgerRuntime((message) => sent.push(message.content), db);
	await settleOneChild(runtime, artifactId);
	runtime.notifyParentRunEnd();

	const hold = createSettleHold({
		liveChildren: () => [{ name: "worker-0", round: 1 }],
		takeNotice: () => runtime.takeHeldNotice?.(),
		commitNotice: () => runtime.commitHeldNotice?.(),
		releaseNotice: () => runtime.releaseHeldNotice?.(),
		ownsBoundary: () => runtime.holdOwnsBoundary?.(),
		returnsBoundary: () => runtime.holdReturnsBoundary?.(),
		pollMs: 5,
		holdMaxMs: 15,
	});
	assert.equal(await hold.beforeSettle({ entries: [], outcome: "completed" }, { mode: "tui" }), undefined);
	assert.equal(sent.length, 0);

	const startedAt = Date.now();
	while (sent.length === 0 && Date.now() - startedAt < 3_000) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	const firedAfterMs = Date.now() - startedAt;
	assert.equal(sent.length, 1, `the production timer did not release the notice (waited ${firedAfterMs}ms)`);
	assert.ok(firedAfterMs >= SETTLE_FALLBACK_MS - 50, `fired after ${firedAfterMs}ms: it must not fire EARLIER than the frozen delay`);
	assert.match(sent[0] ?? "", /Background task completed/);
	assert.equal(runtime.noticeQueueStats().pending, 0);
	runtime.dispose();
	db.close();
});

test("a blocked sibling cannot hide a finished child's notice from the hold", async () => {
	// The hold's gate (`state === "working"`) is narrower than the join's
	// (`watching !== false`): a child blocked on an approval prompt keeps a finished
	// sibling's entry in the join BUFFER instead of the outbox for up to `flushMs`. With no
	// live child left, the hold must flush that buffer — otherwise it takes an empty outbox,
	// exits `completed-empty`, and the feature silently does nothing in a reachable state.
	const db = openLegionDb(":memory:");
	const sent: string[] = [];
	const artifactId = "r-1/worker-0/r1";
	recordOneArtifact(db, artifactId);
	const runtime = ledgerRuntime((message) => sent.push(message.content), db);
	runtime.notifyParentRunStart();
	runtime.track({
		name: "worker-1",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/worker-1.jsonl",
		timeoutMs: 1_000,
		collect: async () => ({
			execution: { status: "running", reason: "blocked: waiting for approval" },
			output: "",
			acceptance: { status: "pending" },
			blocked: true,
		}),
		// The approval prompt is up and never answered: `state === "blocked"`, `watching` true,
		// so the join still counts it as a sibling worth batching for.
		handleBlocked: () => new Promise(() => undefined),
	});
	runtime.watch("worker-1");
	await waitFor(() => runtime.get("worker-1")?.state === "blocked", "blocked child");

	await settleOneChild(runtime, artifactId);
	assert.equal(runtime.noticeQueueStats().pending, 0, "the notice is parked in the join buffer, not the outbox");
	const taken = runtime.takeHeldNotice?.();
	assert.ok(taken, "flushing the buffer is what makes the boundary able to announce it");
	// A partial batch on purpose: the blocked sibling is still out there, so the grouped
	// shape says `1 of 2` and lists it, instead of claiming the run is done.
	assert.match(taken.content, /Background tasks completed \(1 of 2\):/);
	assert.match(taken.content, /- worker-0 \(worker\): completed/);
	assert.match(taken.content, /Still running: worker-1/, "the blocked sibling is reported truthfully");
	runtime.dispose();
	db.close();
});

test("rule 1: `holdReturnsBoundary` is the settle-rescue ARM, and nothing else", () => {
	// The mirror of the pin below, and the reason #418 cannot regress quietly: a hand-back that
	// did anything besides re-arm the ONE timer would either invent a second rescue path or
	// start delivering from a place that has no drafts to deliver.
	const source = readFileSync(new URL("../../src/extension/runtime.ts", import.meta.url), "utf8");
	const start = source.indexOf("holdReturnsBoundary() {");
	assert.ok(start >= 0, "the seam is wired on the runtime");
	const body = source.slice(start, source.indexOf("},", start));
	const statements = body
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("//") && !line.startsWith("holdReturnsBoundary"));
	assert.deepEqual(statements, ["armSettleFallback();"]);
});

test("rule 1: `holdOwnsBoundary` is the settle-rescue cancel, and nothing else", () => {
	// A hold that let the 2s rescue fire mid-wait would deliver — and latch — the very
	// notice the boundary is waiting to announce.
	const source = readFileSync(new URL("../../src/extension/runtime.ts", import.meta.url), "utf8");
	const start = source.indexOf("holdOwnsBoundary() {");
	assert.ok(start >= 0, "the seam is wired on the runtime");
	const body = source.slice(start, source.indexOf("},", start));
	const statements = body
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("//") && !line.startsWith("holdOwnsBoundary"));
	assert.deepEqual(statements, ["cancelSettleFallback();"]);
});
