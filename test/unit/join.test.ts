import { test } from "node:test";
import assert from "node:assert/strict";
import {
	JoinCoordinator,
	type JoinConfig,
	type JoinEntry,
	type JoinSchedulerHandle,
} from "../../src/extension/join.ts";
import type { CompletionStatus } from "../../src/extension/notify.ts";

type Batch = Array<JoinEntry & { status: CompletionStatus }>;

function entry(name: string, runId = "r-1", status = "success"): JoinEntry {
	// `round` is carried but never interpreted here (D10): the coordinator is
	// round-agnostic, so the fixture only has to satisfy the shape.
	return {
		runId,
		name,
		round: 1,
		input: { name, execution: { status }, output: `out-${name}` },
		triggerTurn: true,
	};
}

/** Manual scheduler: records the pending fn so the test fires it itself. */
function manualSchedule() {
	const pending: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
	const schedule = (ms: number, fn: () => void): JoinSchedulerHandle => {
		const slot = { ms, fn, cancelled: false };
		pending.push(slot);
		return {
			cancel: () => {
				slot.cancelled = true;
			},
		};
	};
	const fireLast = () => {
		const slot = pending.at(-1);
		assert.ok(slot && !slot.cancelled, "expected a live scheduled flush");
		slot.fn();
	};
	return { pending, schedule, fireLast };
}

function harness(over: {
	mode?: "each" | "smart";
	flushMs?: number;
} = {}) {
	const timers = manualSchedule();
	const delivered: Batch[] = [];
	const join = new JoinCoordinator({
		schedule: timers.schedule,
		deliver: (entries) => delivered.push(entries),
	});
	join.setConfig({
		mode: over.mode ?? "smart",
		flushMs: over.flushMs ?? 10_000,
	});
	return { join, delivered, timers };
}

test("join: default config is smart with a 10s window (constructor-only)", () => {
	const delivered: Batch[] = [];
	const timers = manualSchedule();
	const join = new JoinCoordinator({
		schedule: timers.schedule,
		deliver: (entries) => delivered.push(entries),
	});
	join.addPending("r-1", "a");
	join.addPending("r-1", "b");
	join.onTerminal(entry("a"));
	assert.equal(delivered.length, 0, "smart default buffers the first finisher");
	assert.equal(timers.pending.length, 1, "window armed");
	assert.equal(timers.pending[0]?.ms, 10_000, "default window is 10s");
});

test("join: each mode delivers immediately, one notice per child", () => {
	const { join, delivered, timers } = harness({ mode: "each" });
	join.addPending("r-1", "a");
	join.addPending("r-1", "b");
	join.onTerminal(entry("a"));
	join.onTerminal(entry("b"));
	assert.equal(delivered.length, 2);
	assert.equal(delivered[0]?.[0]?.name, "a");
	assert.equal(delivered[1]?.[0]?.name, "b");
	assert.equal(timers.pending.length, 0, "each mode must not arm timers");
});

test("join: all members terminal → one immediate grouped flush", () => {
	const { join, delivered, timers } = harness();
	join.addPending("r-1", "a");
	join.addPending("r-1", "b");
	join.onTerminal(entry("a"));
	assert.equal(delivered.length, 0, "first finisher waits for the group");
	join.onTerminal(entry("b"));
	assert.equal(delivered.length, 1, "all-settled flushes immediately");
	assert.deepEqual(
		delivered[0]?.map((e) => e.name),
		["a", "b"],
	);
	// The window armed for `a` is cancelled by the immediate flush.
	assert.equal(timers.pending.at(-1)?.cancelled, true);
});

test("join: window expiry with stragglers flushes only the finished ones", () => {
	const { join, delivered, timers } = harness();
	join.addPending("r-1", "a");
	join.addPending("r-1", "slow");
	join.onTerminal(entry("a"));
	assert.equal(delivered.length, 0);
	timers.fireLast();
	assert.equal(delivered.length, 1);
	assert.deepEqual(
		delivered[0]?.map((e) => e.name),
		["a"],
	);
	assert.equal(join.allSettled("r-1"), false, "slow is still pending");

	// The straggler finishing later is its own settled group → immediate flush.
	join.onTerminal(entry("slow"));
	assert.equal(delivered.length, 2);
	assert.deepEqual(
		delivered[1]?.map((e) => e.name),
		["slow"],
	);
});

// Discriminating against REINTRODUCTION, not against today's snapshot: the
// busy-extension hook is deleted from `JoinConfig`, so a `parentBusy` injected
// here is inert data the coordinator must ignore. The old implementation read
// it, re-armed at expiry, and would produce `pending.length === 2` /
// `delivered.length === 0` — i.e. this test DOES go red if the busy-extension
// path is brought back (verified by re-adding `MAX_BUSY_EXTENSIONS` + the
// `parentBusy` re-arm to join.ts).
test("join: one window per batch — expiry never re-arms even if a busy hook is present", () => {
	const { join, delivered, timers } = harness();
	// `as unknown as JoinConfig`: `parentBusy` is no longer part of the type; the
	// cast is the whole point — it proves the coordinator ignores stray wiring.
	join.setConfig({
		mode: "smart",
		flushMs: 10_000,
		parentBusy: () => true,
	} as unknown as JoinConfig);
	join.addPending("r-1", "a");
	join.addPending("r-1", "slow");
	join.onTerminal(entry("a"));
	assert.equal(delivered.length, 0, "buffered behind the window");
	assert.equal(timers.pending.length, 1, "exactly one window armed");
	timers.fireLast();
	assert.equal(
		delivered.length,
		1,
		"expiry flushes what is buffered even though the busy hook says 'busy'",
	);
	// The window is a batching delay only. Extending it while the parent is
	// busy was both the wrong predictor (turn-level, always busy in the tool
	// loop) and a second delay stacked on the runtime outbox: never re-arm.
	assert.equal(
		timers.pending.length,
		1,
		"no second window may be scheduled at expiry",
	);
});

test("join: the first window expiry flushes (no busy gate)", () => {
	const { join, delivered, timers } = harness();
	join.addPending("r-1", "a");
	join.addPending("r-1", "slow");
	join.onTerminal(entry("a"));
	timers.fireLast();
	assert.equal(delivered.length, 1);
});

test("join: remove() drops a member so the group can settle without it", () => {
	const { join, delivered } = harness();
	join.addPending("r-1", "a");
	join.addPending("r-1", "gone");
	join.remove("gone");
	assert.equal(join.allSettled("r-1"), false, "a still pending");
	join.onTerminal(entry("a"));
	assert.equal(delivered.length, 1, "removed member does not block the flush");
});

test("join: failed entries keep their failed status in the batch", () => {
	const { join, delivered } = harness();
	join.addPending("r-1", "a");
	join.addPending("r-1", "b");
	join.onTerminal(entry("a"));
	join.onTerminal(entry("b", "r-1", "failed"));
	assert.equal(delivered.length, 1);
	assert.deepEqual(
		delivered[0]?.map((e) => e.status),
		["completed", "failed"],
	);
});

test("join: onTerminal without tracking delivers directly instead of dropping", () => {
	const { join, delivered } = harness();
	join.onTerminal(entry("orphan"));
	assert.equal(delivered.length, 1);
});

test("join: dispose cancels timers and swallows nothing", () => {
	const { join, delivered, timers } = harness();
	join.addPending("r-1", "a");
	join.addPending("r-1", "slow");
	join.onTerminal(entry("a"));
	join.dispose();
	assert.equal(timers.pending.at(-1)?.cancelled, true);
	assert.equal(delivered.length, 0, "dispose discards the buffered batch");
	// Post-dispose calls are inert.
	join.onTerminal(entry("slow"));
	assert.equal(delivered.length, 0);
});

test("join: two runs batch independently", () => {
	const { join, delivered } = harness();
	join.addPending("r-1", "a");
	join.addPending("r-1", "b");
	join.addPending("r-2", "c");
	join.onTerminal(entry("a", "r-1"));
	join.onTerminal(entry("c", "r-2"));
	assert.equal(delivered.length, 1, "r-2 is a single-member group");
	join.onTerminal(entry("b", "r-1"));
	assert.equal(delivered.length, 2);
	assert.deepEqual(
		delivered[1]?.map((e) => e.name),
		["a", "b"],
	);
});

// ─────────────────── U4: a running entry is not a completion (B) ───────────────────

test("U4: onTerminal fails loud on a running entry instead of buffering a lie", () => {
	// A running snapshot means collect timed out while the child is alive
	// (F29). The runtime's watch() re-arms on it; if it ever reached the
	// coordinator the aggregate would be built from a non-completion, so the
	// coordinator refuses rather than silently mapping it to `failed`.
	const { join, delivered } = harness();
	join.addPending("r-1", "live");
	assert.throws(
		() => join.onTerminal(entry("live", "r-1", "running")),
		/running snapshot is not a completion/,
	);
	assert.equal(delivered.length, 0, "nothing may be delivered for a running entry");
	// The failed member is still pending, so the group was not corrupted.
	assert.equal(join.allSettled("r-1"), false);
});

test("U4: a running entry mixed into a batch is refused, not merged", () => {
	const { join, delivered } = harness();
	join.addPending("r-1", "done");
	join.addPending("r-1", "live");
	join.onTerminal(entry("done"));
	assert.throws(
		() => join.onTerminal(entry("live", "r-1", "running")),
		/running snapshot is not a completion/,
	);
	assert.equal(delivered.length, 0, "the batch must not flush around a running member");
});

// ─────────────────── D8: dropBuffered — the W3 orphan horizon ───────────────────

test("D8: dropBuffered removes one terminal member and keeps the rest of the group", () => {
	const { join, delivered } = harness();
	join.addPending("r-1", "a");
	join.addPending("r-1", "b");
	join.onTerminal(entry("a"));
	// `a` has already reached the parent through the tool route: its buffered
	// entry is dead weight, `b` is still the notice's only memory.
	join.dropBuffered("r-1", "a");
	join.onTerminal(entry("b"));
	assert.equal(delivered.length, 1);
	assert.deepEqual(
		delivered[0]?.map((e) => e.name),
		["b"],
		"only the unclaimed member flushes",
	);
});

test("D8: remove() alone still leaves a buffered entry behind (the W3 orphan shape)", () => {
	// Pinned on purpose: `remove()` is pending-only BY CONTRACT, which is why the
	// runtime needs `dropBuffered` at all. If this ever flips to dropping the
	// buffer, the W3 bug would look fixed while the batching path breaks.
	const { join, delivered } = harness();
	join.addPending("r-1", "a");
	join.addPending("r-1", "b");
	join.onTerminal(entry("a"));
	join.remove("a");
	join.onTerminal(entry("b"));
	assert.deepEqual(
		delivered[0]?.map((e) => e.name),
		["a", "b"],
		"remove() does not touch the buffered batch",
	);
});

test("D8: dropBufferedRound drops one round and leaves an older unread copy alone (D10)", () => {
	// `release()` acts on ONE tracked job = one round, so the only copy it may drop
	// is that round's. Reaching for the name-wide drop there deleted round 1's
	// still-unread notice when round 2 was the one the parent had just read.
	const { join, delivered } = harness();
	join.addPending("r-1", "a");
	join.addPending("r-1", "b");
	join.onTerminal(entry("a", "r-1", "success")); // round 1: buffered, unread
	join.addPending("r-1", "a"); // re-tracked: round 2 joins the group again
	join.onTerminal({ ...entry("a"), round: 2 }); // round 2: buffered too

	join.dropBufferedRound("r-1", "a", 2);
	join.onTerminal(entry("b")); // everyone home → flush
	assert.deepEqual(
		delivered[0]?.map((e) => `${e.name}#${e.round}`),
		["a#1", "b#1"],
		"only round 2 was dropped; round 1 is still deliverable",
	);
});

test("D7: dropBuffered keeps its NAME-WIDE meaning — every round of the member", () => {
	// The counterpart of the case above, pinned on purpose: the revoke path needs
	// name-wide clearing ("the parent asks to see the child again ⇒ every copy of
	// that name is stale"), which is why the round-scoped drop is a SEPARATE method
	// rather than a changed `dropBuffered`.
	const { join, delivered } = harness();
	join.addPending("r-1", "a");
	join.addPending("r-1", "b");
	join.onTerminal(entry("a"));
	join.addPending("r-1", "a");
	join.onTerminal({ ...entry("a"), round: 2 });

	join.dropBuffered("r-1", "a");
	join.onTerminal(entry("b"));
	assert.deepEqual(
		delivered[0]?.map((e) => `${e.name}#${e.round}`),
		["b#1"],
		"a revoke clears every round of the name",
	);
});

test("D8: dropBuffered on the last member drops the group and cancels its window", () => {
	const { join, delivered, timers } = harness();
	join.addPending("r-1", "a");
	join.addPending("r-1", "b");
	join.onTerminal(entry("a"));
	join.remove("b");
	join.dropBuffered("r-1", "a");
	assert.equal(timers.pending.at(-1)?.cancelled, true, "the window dies with the group");
	assert.equal(join.allSettled("r-1"), true);
	assert.equal(delivered.length, 0, "nothing was delivered");
	// The group is gone, so a later terminal is not batched into a stale one.
	join.onTerminal(entry("a"));
	assert.equal(delivered.length, 1);
});
