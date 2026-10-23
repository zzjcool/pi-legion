/**
 * Unit tests for the launch admission queue (issue #266, contract
 * `launch-admission-queue-v1` §4.1 / A6 / A14 / A17).
 *
 * The queue is a pure module: the clock is injected, no timer ever fires, and
 * timeouts are only evaluated when `next()` is called (R7). Everything below
 * drives it with a manual clock.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
	DEFAULT_LAUNCH_QUEUE_MAX_PENDING,
	DEFAULT_LAUNCH_QUEUE_TIMEOUT_MS,
	LAUNCH_QUEUE_RECHECK_MS,
	acquireAdmissionQueue,
	createAdmissionQueue,
	evaluateInProcessAdmission,
	inProcessActiveMessage,
	inProcessDepthMessage,
	inProcessFanoutMessage,
	inProcessSpawnsMessage,
	queueOverflowMessage,
	queueTimeoutMessage,
	resetAdmissionQueuesForTests,
	setLaunchQueueListener,
	type AdmissionQueue,
	type AdmissionVerdict,
	type InProcessAdmissionCounts,
	type LaunchQueueEvent,
} from "../../src/supervisor/admission-queue.ts";

// ── helpers ───────────────────────────────────────────────────────────────

function counts(overrides: Partial<InProcessAdmissionCounts> = {}): InProcessAdmissionCounts {
	return {
		parentKey: "root",
		siblings: 0,
		active: 0,
		spawnCount: 0,
		depth: 0,
		limits: { maxDepth: 4, maxChildrenPerNode: 8, maxActive: 30 },
		...overrides,
	};
}

const ADMIT: AdmissionVerdict = { admitted: true };

function blockedOn(gate: "fanout" | "active"): AdmissionVerdict {
	return gate === "fanout"
		? {
				admitted: false,
				queueable: true,
				gate: "inprocess.maxChildrenPerNode",
				dimension: "fanout",
				message: "fanout gate",
			}
		: {
				admitted: false,
				queueable: true,
				gate: "inprocess.maxActive",
				dimension: "active",
				message: "active gate",
			};
}

interface Clock {
	now: () => number;
	advance: (ms: number) => void;
}

function makeClock(start = 1_000): Clock {
	let current = start;
	return { now: () => current, advance: (ms) => { current += ms; } };
}

// ── §4.1: frozen copy constructors (A6 compares these byte-for-byte) ──────

test("admission queue: message constructors match the frozen copy", () => {
	assert.equal(
		inProcessSpawnsMessage(3, 5),
		"inprocess spawn budget exhausted (3/5); raise subagents.inprocess.maxSpawnsPerSession to allow more",
	);
	assert.equal(
		inProcessActiveMessage(30, 30),
		"inprocess maxActive reached (30/30); raise subagents.inprocess.maxActive to allow more",
	);
	assert.equal(
		inProcessDepthMessage(4, 4),
		"inprocess nesting limit reached (depth 4, max 4); raise subagents.inprocess.maxDepth to allow deeper nesting",
	);
	assert.equal(
		inProcessFanoutMessage("root", 8, 8),
		"inprocess maxChildrenPerNode reached for 'root' (8/8)",
	);
	assert.equal(
		inProcessFanoutMessage("", 0, 8),
		"inprocess maxChildrenPerNode reached for '<root>' (0/8)",
	);
	assert.equal(
		queueOverflowMessage(32, 32),
		"launch queue overflow (32/32); raise subagents.inprocess.maxQueuedLaunches to allow more",
	);
	assert.equal(queueTimeoutMessage("scout-7", 42_400), "launch queue timed out after 42s ('scout-7')");
});

test("admission queue: defaults are frozen at 32 pending / 900000 ms / 1000 ms recheck", () => {
	assert.equal(DEFAULT_LAUNCH_QUEUE_MAX_PENDING, 32);
	assert.equal(DEFAULT_LAUNCH_QUEUE_TIMEOUT_MS, 900_000);
	assert.equal(LAUNCH_QUEUE_RECHECK_MS, 1000);
	const queue = createAdmissionQueue();
	assert.equal(queue.maxPending, 32);
	assert.equal(queue.timeoutMs, 900_000);
});

// ── D1-a: one gate function, four messages, assertWithinLimits order ─────

test("evaluateInProcessAdmission: admits below every limit", () => {
	assert.deepEqual(evaluateInProcessAdmission(counts()), { admitted: true });
	assert.deepEqual(
		evaluateInProcessAdmission(counts({ siblings: 7, active: 29, depth: 3 })),
		{ admitted: true },
	);
});

test("evaluateInProcessAdmission: maxSpawnsPerSession is a hard gate and comes first", () => {
	const verdict = evaluateInProcessAdmission(
		counts({
			spawnCount: 3,
			siblings: 8,
			active: 30,
			depth: 4,
			limits: { maxDepth: 4, maxChildrenPerNode: 8, maxActive: 30, maxSpawnsPerSession: 3 },
		}),
	);
	assert.deepEqual(verdict, {
		admitted: false,
		queueable: false,
		gate: "inprocess.maxSpawnsPerSession",
		message:
			"inprocess spawn budget exhausted (3/3); raise subagents.inprocess.maxSpawnsPerSession to allow more",
	});
});

test("evaluateInProcessAdmission: maxActive before maxDepth before maxChildrenPerNode", () => {
	assert.deepEqual(
		evaluateInProcessAdmission(counts({ active: 30, depth: 4, siblings: 8 })),
		{
			admitted: false,
			queueable: true,
			gate: "inprocess.maxActive",
			dimension: "active",
			message: "inprocess maxActive reached (30/30); raise subagents.inprocess.maxActive to allow more",
		},
	);
	assert.deepEqual(
		evaluateInProcessAdmission(counts({ depth: 4, siblings: 8 })),
		{
			admitted: false,
			queueable: false,
			gate: "inprocess.maxDepth",
			message:
				"inprocess nesting limit reached (depth 4, max 4); raise subagents.inprocess.maxDepth to allow deeper nesting",
		},
	);
	assert.deepEqual(
		evaluateInProcessAdmission(counts({ siblings: 8 })),
		{
			admitted: false,
			queueable: true,
			gate: "inprocess.maxChildrenPerNode",
			dimension: "fanout",
			message: "inprocess maxChildrenPerNode reached for 'root' (8/8)",
		},
	);
});

test("evaluateInProcessAdmission: depth gate fires on depth+1, message prints the current depth", () => {
	// maxDepth 4 with depth 3 is fine (next child sits at 4); depth 4 is refused.
	assert.deepEqual(evaluateInProcessAdmission(counts({ depth: 3 })), { admitted: true });
	const verdict = evaluateInProcessAdmission(counts({ depth: 4 }));
	assert.equal(verdict.admitted, false);
	assert.equal(verdict.admitted === false && verdict.gate, "inprocess.maxDepth");
	assert.equal(
		verdict.admitted === false && verdict.message,
		"inprocess nesting limit reached (depth 4, max 4); raise subagents.inprocess.maxDepth to allow deeper nesting",
	);
});

test("evaluateInProcessAdmission: empty parentKey renders <root> in the fanout message", () => {
	const verdict = evaluateInProcessAdmission(counts({ parentKey: "", siblings: 8 }));
	assert.equal(verdict.admitted, false);
	assert.equal(
		verdict.admitted === false && verdict.message,
		"inprocess maxChildrenPerNode reached for '<root>' (8/8)",
	);
});

// ── D11: maxChildrenPerNode === 0 is a hard refusal, never queueable ─────

test("evaluateInProcessAdmission: maxChildrenPerNode 0 refuses with the .disabled gate (D11)", () => {
	const verdict = evaluateInProcessAdmission(
		counts({ siblings: 0, limits: { maxDepth: 4, maxChildrenPerNode: 0, maxActive: 30 } }),
	);
	assert.deepEqual(verdict, {
		admitted: false,
		queueable: false,
		gate: "inprocess.maxChildrenPerNode.disabled",
		message: "inprocess maxChildrenPerNode reached for 'root' (0/0)",
	});
});

// ── D2-b: inflight reservation offsets the two queueable dimensions ─────

test("evaluateInProcessAdmission: inflight fanout blocks even when counts are empty", () => {
	// 8 sibling launches in one tick: counts still read 0, the reservation says 8.
	const fanout = evaluateInProcessAdmission(counts({ siblings: 0 }), { fanout: 8, active: 8 });
	assert.deepEqual(fanout, {
		admitted: false,
		queueable: true,
		gate: "inprocess.maxChildrenPerNode",
		dimension: "fanout",
		message: "inprocess maxChildrenPerNode reached for 'root' (8/8)",
	});
	// The fanout reservation alone is enough; siblings never changed.
	assert.deepEqual(
		evaluateInProcessAdmission(counts({ siblings: 0 }), { fanout: 8, active: 0 }),
		fanout,
	);
});

test("evaluateInProcessAdmission: inflight active is added to counts.active", () => {
	const verdict = evaluateInProcessAdmission(
		counts({ active: 4, limits: { maxDepth: 4, maxChildrenPerNode: 100, maxActive: 8 } }),
		{ fanout: 0, active: 4 },
	);
	assert.deepEqual(verdict, {
		admitted: false,
		queueable: true,
		gate: "inprocess.maxActive",
		dimension: "active",
		message: "inprocess maxActive reached (8/8); raise subagents.inprocess.maxActive to allow more",
	});
});

test("evaluateInProcessAdmission: inflight never softens a hard gate", () => {
	const verdict = evaluateInProcessAdmission(counts({ depth: 4 }), { fanout: 0, active: 0 });
	assert.equal(verdict.admitted, false);
	assert.equal(verdict.admitted === false && verdict.queueable, false);
	assert.equal(verdict.admitted === false && verdict.gate, "inprocess.maxDepth");
});

// ── D5/D6: ordering, overflow, timeout (no timer, R7) ────────────────────

test("admission queue: enqueue is FIFO by a single seq and next() dequeues", () => {
	const queue = createAdmissionQueue<number>();
	const a = queue.enqueue(1, { name: "a", parentKey: "root" });
	const b = queue.enqueue(2, { name: "b", parentKey: "root" });
	const c = queue.enqueue(3, { name: "c", parentKey: "root" });
	assert.equal(a.ok && a.position, 1);
	assert.equal(b.ok && b.position, 2);
	assert.equal(c.ok && c.position, 3);
	assert.equal(queue.size, 3);
	assert.equal(queue.positionOf("b"), 2);

	const first = queue.next(() => ADMIT);
	assert.equal(first.kind, "admit");
	assert.equal(first.kind === "admit" && first.item.name, "a");
	assert.equal(queue.size, 2);
	assert.equal(queue.positionOf("b"), 1, "positions collapse after a dequeue");

	const second = queue.next(() => ADMIT);
	assert.equal(second.kind === "admit" && second.item.name, "b");
	const third = queue.next(() => ADMIT);
	assert.equal(third.kind === "admit" && third.item.name, "c");
	assert.deepEqual(queue.next(() => ADMIT), { kind: "none" });
});

test("admission queue: a blocked smaller seq is skipped, not allowed to block (head-of-line, D5-2)", () => {
	const queue = createAdmissionQueue<{ blocked: boolean }>();
	queue.enqueue({ blocked: true }, { name: "seq1-active", parentKey: "root" });
	queue.enqueue({ blocked: false }, { name: "seq2-fanout", parentKey: "root" });
	queue.enqueue({ blocked: false }, { name: "seq3-fanout", parentKey: "root" });

	const next = queue.next((item) => (item.payload.blocked ? blockedOn("active") : ADMIT));
	assert.equal(next.kind, "admit");
	assert.equal(next.kind === "admit" && next.item.name, "seq2-fanout");
	assert.equal(queue.size, 2);
	assert.equal(queue.positionOf("seq1-active"), 1, "the skipped item keeps its place");
});

test("admission queue: order is never reordered by parentKey (D5-3)", () => {
	const queue = createAdmissionQueue<unknown>();
	queue.enqueue(null, { name: "a", parentKey: "z-parent" });
	queue.enqueue(null, { name: "b", parentKey: "a-parent" });
	queue.enqueue(null, { name: "c", parentKey: "z-parent" });
	const next = queue.next(() => ADMIT);
	assert.equal(next.kind === "admit" && next.item.name, "a");
	assert.deepEqual(
		queue.entries().map((entry) => entry.name),
		["b", "c"],
	);
});

test("admission queue: overflow refuses the enqueue and writes no item (D6)", () => {
	const queue = createAdmissionQueue<number>({ maxPending: 2 });
	queue.enqueue(1, { name: "a", parentKey: "root" });
	queue.enqueue(2, { name: "b", parentKey: "root" });
	const third = queue.enqueue(3, { name: "c", parentKey: "root" });
	assert.deepEqual(third, {
		ok: false,
		kind: "overflow",
		message: "launch queue overflow (2/2); raise subagents.inprocess.maxQueuedLaunches to allow more",
	});
	assert.equal(queue.size, 2);
	assert.equal(queue.positionOf("c"), undefined);
});

test("admission queue: timeout is decided in next(), never by a timer (D6/R7)", () => {
	const clock = makeClock(5_000);
	const queue = createAdmissionQueue<number>({ timeoutMs: 900_000, now: clock.now });
	queue.enqueue(1, { name: "waiting", parentKey: "root" });
	clock.advance(899_999);
	const early = queue.next(() => ADMIT);
	assert.equal(early.kind, "admit", "one ms short of the deadline still admits");
	assert.equal(early.kind === "admit" && early.waitedMs, 899_999);

	queue.enqueue(2, { name: "slow", parentKey: "root" });
	clock.advance(900_000);
	const expired = queue.next(() => ADMIT);
	assert.equal(expired.kind, "expired");
	assert.equal(expired.kind === "expired" && expired.item.name, "slow");
	assert.equal(expired.kind === "expired" && expired.waitedMs, 900_000);
	assert.deepEqual(expired.kind === "expired" && expired.message, "launch queue timed out after 900s ('slow')");
	assert.equal(queue.size, 0);
});

test("admission queue: an item under admission can never be expired later (R7)", () => {
	const clock = makeClock(0);
	const queue = createAdmissionQueue<number>({ timeoutMs: 1_000, now: clock.now });
	queue.enqueue(1, { name: "admitting", parentKey: "root" });
	const admitted = queue.next(() => ADMIT);
	assert.equal(admitted.kind, "admit");
	// The item left the queue synchronously, so no later `next()` may time it out
	// while its run() is still in flight.
	clock.advance(10_000);
	assert.deepEqual(queue.next(() => ADMIT), { kind: "none" });
});

test("admission queue: nextDeadlineAt is min(earliest expiry, now + recheck)", () => {
	const clock = makeClock(1_000);
	const queue = createAdmissionQueue<number>({ timeoutMs: 900_000, now: clock.now });
	assert.equal(queue.nextDeadlineAt(), undefined);
	queue.enqueue(1, { name: "a", parentKey: "root" });
	// Earliest expiry 901000 far away → the recheck window wins.
	assert.equal(queue.nextDeadlineAt(), 1_000 + LAUNCH_QUEUE_RECHECK_MS);
	clock.advance(900_500);
	// Expiry 901000 is now nearer than now+1000 = 901500.
	assert.equal(queue.nextDeadlineAt(), 901_000);
	queue.remove("a");
	assert.equal(queue.nextDeadlineAt(), undefined);
});

test("admission queue: stop/abort helpers remove and flush in seq order", () => {
	const queue = createAdmissionQueue<number>();
	queue.enqueue(1, { name: "a", parentKey: "root" });
	queue.enqueue(2, { name: "b", parentKey: "root" });
	queue.enqueue(3, { name: "c", parentKey: "root" });

	const removed = queue.remove("b");
	assert.equal(removed?.name, "b");
	assert.equal(queue.remove("b"), undefined, "remove is idempotent");
	assert.equal(queue.size, 2);

	const flushed = queue.flush();
	assert.deepEqual(
		flushed.map((item) => item.name),
		["a", "c"],
	);
	assert.equal(queue.size, 0);
	assert.deepEqual(queue.flush(), []);
});

test("admission queue: waitedMs and entries report the injected clock", () => {
	const clock = makeClock(0);
	const queue = createAdmissionQueue<number>({ now: clock.now });
	queue.enqueue(1, { name: "a", parentKey: "root" });
	queue.enqueue(2, { name: "b", parentKey: "other" });
	clock.advance(4_200);
	assert.equal(queue.waitedMs("a"), 4_200);
	assert.equal(queue.waitedMs("nope"), undefined);
	assert.deepEqual(queue.entries(), [
		{ name: "a", parentKey: "root", seq: 1, position: 1, waitedMs: 4_200 },
		{ name: "b", parentKey: "other", seq: 2, position: 2, waitedMs: 4_200 },
	]);
});

// ── A17 / I-O6: process-level registry ───────────────────────────────────

test("admission queue registry: one queue per (pid, scope), reset clears it", () => {
	resetAdmissionQueuesForTests();
	try {
		const first = acquireAdmissionQueue<number>("run-dir-A");
		const again = acquireAdmissionQueue<number>("run-dir-A");
		assert.equal(first, again, "the same scope resolves to the same queue");
		assert.equal(first.positionOf("x"), undefined);

		const other = acquireAdmissionQueue<number>("run-dir-B");
		assert.notEqual(other, first, "a different scope gets a different queue");

		first.enqueue(1, { name: "x", parentKey: "root" });
		assert.equal(again.positionOf("x"), 1, "the second reader sees the first writer's item");
		assert.equal(other.size, 0);

		resetAdmissionQueuesForTests();
		const afterReset = acquireAdmissionQueue<number>("run-dir-A");
		assert.notEqual(afterReset, first, "reset drops the registry");
		assert.equal(afterReset.size, 0);
	} finally {
		resetAdmissionQueuesForTests();
	}
});

test("admission queue registry: keys carry the process pid (I-O6)", () => {
	resetAdmissionQueuesForTests();
	try {
		acquireAdmissionQueue("run-dir-pid");
		// SAFETY: the registry is this module's own globalThis slot; the test just
		// reads its keys to assert the pid namespacing. An empty map is fine.
		const registry = (globalThis as unknown as {
			[symbol: symbol]: Map<string, unknown> | undefined;
		})[Symbol.for("pi-legion.launch-admission-queue")];
		assert.ok(registry, "the registry lives on globalThis under Symbol.for");
		const keys = [...registry.keys()];
		assert.deepEqual(keys, [`${process.pid}:run-dir-pid`]);
	} finally {
		resetAdmissionQueuesForTests();
	}
});

// ── D9: listener events ─────────────────────────────────────────────────

test("admission queue listener: queued / admitted / expired / overflow / stopped / flushed", () => {
	const events: LaunchQueueEvent[] = [];
	setLaunchQueueListener((event) => events.push(event));
	const clock = makeClock(0);
	try {
		const queue = createAdmissionQueue<number>({ maxPending: 2, timeoutMs: 10_000, now: clock.now });
		queue.enqueue(1, { name: "a", parentKey: "root" });
		assert.deepEqual(events.map((event) => event.phase), ["queued"]);
		assert.deepEqual(events[0], { phase: "queued", name: "a", position: 1, queued: 1 });

		clock.advance(3_000);
		queue.next(() => ADMIT);
		const admitted = events.at(-1);
		assert.equal(admitted?.phase, "admitted");
		assert.equal(admitted?.name, "a");
		assert.equal(admitted?.waitedMs, 3_000);
		assert.equal(admitted?.queued, 0);

		queue.enqueue(2, { name: "b", parentKey: "root" });
		clock.advance(10_000);
		queue.next(() => ADMIT);
		const expired = events.at(-1);
		assert.equal(expired?.phase, "expired");
		assert.equal(expired?.name, "b");
		assert.equal(expired?.queued, 0);

		queue.enqueue(3, { name: "c", parentKey: "root" });
		queue.enqueue(4, { name: "d", parentKey: "root" });
		const overflow = queue.enqueue(5, { name: "e", parentKey: "root" });
		assert.equal(overflow.ok, false);
		assert.equal(events.at(-1)?.phase, "overflow");
		assert.equal(events.at(-1)?.name, "e");

		queue.remove("c");
		assert.equal(events.at(-1)?.phase, "stopped");
		assert.equal(events.at(-1)?.name, "c");

		queue.enqueue(6, { name: "f", parentKey: "root" });
		const flushed = queue.flush();
		assert.deepEqual(
			flushed.map((item) => item.name),
			["d", "f"],
		);
		assert.equal(events.at(-1)?.phase, "flushed");
	} finally {
		setLaunchQueueListener(undefined);
	}
});

test("admission queue listener: a throwing listener cannot break admission", () => {
	setLaunchQueueListener(() => {
		throw new Error("pill blew up");
	});
	try {
		const queue = createAdmissionQueue<number>();
		const outcome = queue.enqueue(1, { name: "a", parentKey: "root" });
		assert.equal(outcome.ok, true);
		const next = queue.next(() => ADMIT);
		assert.equal(next.kind, "admit");
	} finally {
		setLaunchQueueListener(undefined);
	}
});

// ── §13.7-1 / A17: the module stays pure (lint-by-reading) ──────────────

test("admission-queue.ts is a pure module: no fs, no path, no timer, no process.env", () => {
	const source = readFileSync(
		path.resolve(import.meta.dirname, "../../src/supervisor/admission-queue.ts"),
		"utf8",
	);
	for (const forbidden of [
		'from "node:fs"',
		'from "fs"',
		"node:path",
		"setTimeout(",
		"setInterval(",
		"process.env",
	]) {
		assert.equal(source.includes(forbidden), false, `admission-queue.ts must not contain ${forbidden}`);
	}
	// The one allowed process reference is the pid used to namespace the registry (I-O6).
	assert.ok(source.includes("process.pid"), "the registry key must carry process.pid");
});

// ── shape guard: queue type is usable generically ──────────────────────

test("admission queue: generic payload survives enqueue/next", () => {
	const queue: AdmissionQueue<{ run: () => void }> = createAdmissionQueue<{ run: () => void }>();
	let ran = 0;
	queue.enqueue({ run: () => { ran += 1; } }, { name: "job", parentKey: "root" });
	const next = queue.next(() => ADMIT);
	assert.equal(next.kind, "admit");
	if (next.kind === "admit") next.item.payload.run();
	assert.equal(ran, 1);
});
