/**
 * Unit tests for `src/extension/liveness.ts` — the single authority for "is this
 * child alive?" (contract `docs/contracts/display-liveness-v1.md`, W1).
 *
 * Scope is the acceptance rows W1 owns:
 *  - A1: each of D1's eight ordered rules, one case per rule (the eight are a
 *        total order, so the two order-sensitive overlaps are pinned explicitly:
 *        a terminal `inMemory` must beat `pidAlive: true`, and a non-terminal
 *        `inMemory` must beat `pidAlive: false`);
 *  - A2/A6 (W1 half): the same facts projected any number of times give one
 *        answer — the property that replaces the `#238` KNOWN LIMITATION;
 *  - A4 (W1 half): the D5 mapping, `idle → idle`, `queued → queued`,
 *        `undefined → unknown`;
 *  - D2: `unknown` is never treated as `live`;
 *  - §7-7: the module is pure — asserted by reading its own source.
 *
 * The clock is a plain number here on purpose: `liveness()` takes `now` as an
 * argument, so the tests never have to fake timers, and a "1 ms later" answer
 * can be requested explicitly.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
	NON_TERMINAL,
	TERMINAL_STATES,
	displayStatusFromState,
	isTerminalState,
	liveness,
	type Liveness,
	type LivenessFacts,
} from "../../src/extension/liveness.ts";

const NOW = 1_700_000_000_000;
const STALE_MS = 90_000;

/** Facts with every optional source absent; each test opts sources in. */
function facts(overrides: Partial<LivenessFacts> = {}): LivenessFacts {
	return { now: NOW, staleMs: STALE_MS, ...overrides };
}

// ── A1: the eight ordered rules, one case each ────────────────────────────
//
// Each test names the rule it pins so a failing case maps straight back to a
// numbered line of D1. Rules 1-2 and 3-4 carry a hostile lower-priority fact
// wherever the order is observable, because a union implementation would pass a
// naive "each rule alone" suite while still diverging on overlaps.

test("A1-1: inMemory present and non-terminal → live (even though the ledger heartbeat is stale)", () => {
	assert.equal(
		liveness(facts({
			inMemory: { state: "working" },
			ledger: { status: "running", updatedAt: NOW - STALE_MS * 10 },
		})),
		"live",
	);
});

test("A1-2: inMemory present and terminal → dead, and it OUTRANKS pidAlive=true (order-sensitive)", () => {
	// The child this process is holding has already settled; a bare pid probe
	// still seeing the (just-exited) process must not resurrect it.
	assert.equal(
		liveness(facts({ inMemory: { state: "settled" }, pidAlive: true })),
		"dead",
	);
});

test("A1-3: no inMemory, pidAlive === true → live (outranks a stale ledger row)", () => {
	assert.equal(
		liveness(facts({
			pidAlive: true,
			ledger: { status: "starting", updatedAt: NOW - STALE_MS * 10 },
			record: { state: "retired" },
		})),
		"live",
	);
});

test("A1-4: no inMemory, pidAlive === false → dead immediately, with no heartbeat grace (D4)", () => {
	// The ledger row is fresh on purpose: D4 forbids a second time semantics that
	// would let a fresh heartbeat outvote a confirmed-dead pid.
	assert.equal(
		liveness(facts({
			pidAlive: false,
			ledger: { status: "running", updatedAt: NOW - 1 },
		})),
		"dead",
	);
});

test("A1-5: ledger non-terminal and heartbeat fresh (now - updatedAt < staleMs) → live", () => {
	assert.equal(
		liveness(facts({ ledger: { status: "running", updatedAt: NOW - (STALE_MS - 1) } })),
		"live",
	);
});

test("A1-6: ledger non-terminal and heartbeat expired → dead (orphan, D7 converges it)", () => {
	assert.equal(
		liveness(facts({ ledger: { status: "running", updatedAt: NOW - STALE_MS } })),
		"dead",
	);
});

test("A1-7: ledger terminal/absent, record terminal → dead", () => {
	assert.equal(liveness(facts({ record: { state: "retired" } })), "dead");
	// A terminal ledger row is not rule 5/6 (that branch needs non-terminal), so
	// it falls through to the record verdict.
	assert.equal(
		liveness(facts({
			ledger: { status: "failed", updatedAt: NOW },
			record: { state: "failed" },
		})),
		"dead",
	);
});

test("A1-8: nothing to go on (all sources undefined) → unknown, never live", () => {
	assert.equal(liveness(facts()), "unknown");
	// A non-terminal record is not rule 7 either: scheduling state alone does not
	// prove a process exists.
	assert.equal(liveness(facts({ record: { state: "working" } })), "unknown");
});

test("A1-7: a terminal LEDGER row alone is dead (D1-a amendment, 2026-10-24)", () => {
	// The frozen draft listed eight rules and rule 7 spoke only of `record`, which
	// left a ledger row that reached `failed` with no scheduler record at `unknown`.
	// D1-a corrected that: a ledger row in TERMINAL_STATES states a finished
	// lifecycle, and "unknown" would have the panel call a finished child undecided.
	assert.equal(liveness(facts({ ledger: { status: "failed", updatedAt: NOW } })), "dead");
	assert.equal(liveness(facts({ ledger: { status: "settled", updatedAt: NOW } })), "dead");
	// A terminal record on its own still answers dead too (rule 8).
	assert.equal(liveness(facts({ record: { state: "failed" } })), "dead");
	// And an ABSENT ledger must stay out of rule 7 entirely.
	assert.equal(liveness(facts({})), "unknown");
});

test("A1-a: `awaiting` is alive, not terminal — a waiting centurion must not vanish", () => {
	// `awaiting` means "alive, waiting on downstream"
	// (src/runs/orchestrator.ts:2271, and src/extension/recycle.ts:23 lists it
	// beside the live states). D1-a therefore keeps it out of TERMINAL_STATES.
	// If it were terminal, an in-flight `awaiting` record would read `dead` and
	// the status panel would drop a squad that is merely waiting.
	assert.equal(isTerminalState("awaiting"), false, "awaiting is not terminal");
	assert.equal(liveness(facts({ inMemory: { state: "awaiting" } })), "live");
	assert.equal(
		liveness(facts({ record: { state: "awaiting" } })),
		"unknown",
		"a lone awaiting record is undecided, and never 'dead'",
	);
	// A fresh heartbeat on an `awaiting` ledger row keeps it live (rule 5).
	assert.equal(liveness(facts({ ledger: { status: "awaiting", updatedAt: NOW } })), "live");
});

test("A1: inMemory non-terminal OUTRANKS pidAlive=false (order-sensitive, rule 1 before rule 4)", () => {
	// A pid marker can be missing or from a different launch attempt; a live
	// handle in this process is stronger evidence than the marker.
	assert.equal(
		liveness(facts({ inMemory: { state: "starting" }, pidAlive: false })),
		"live",
	);
});

test("A1: state normalisation is case-insensitive and does not depend on unknown labels being terminal", () => {
	assert.equal(liveness(facts({ inMemory: { state: "SETTLED" } })), "dead");
	assert.equal(liveness(facts({ inMemory: { state: "blocked" } })), "live");
	// An unrecognised state is not terminal, so a live handle keeps it live…
	assert.equal(liveness(facts({ inMemory: { state: "awaiting" } })), "live");
	// …and a *fresh* ledger row with an unrecognised non-terminal label is rule 5.
	assert.equal(liveness(facts({ ledger: { status: "awaiting", updatedAt: NOW } })), "live");
	// Once that same row goes stale it is an orphan and rule 6 applies.
	assert.equal(liveness(facts({ ledger: { status: "awaiting", updatedAt: NOW - STALE_MS } })), "dead");
});

// ── D2: the third state is real ──────────────────────────────────────────

test("D2: unknown is distinct from live and is not coerced into it", () => {
	const verdict: Liveness = liveness(facts());
	assert.equal(verdict, "unknown");
	assert.notEqual(verdict, "live");
	// The three values are the whole domain — no fourth "probably live" exists.
	assert.deepEqual([...new Set([verdict, "live", "dead"])].sort(), ["dead", "live", "unknown"]);
});

// ── A2 / A6: projection, not replay ──────────────────────────────────────

test("A6: the same facts projected 100 times give one answer (replaces #238's KNOWN LIMITATION)", () => {
	const cases: LivenessFacts[] = [
		facts({ inMemory: { state: "working" } }),
		facts({ inMemory: { state: "failed" } }),
		facts({ pidAlive: true }),
		facts({ pidAlive: false }),
		facts({ ledger: { status: "running", updatedAt: NOW - 1_000 } }),
		facts({ ledger: { status: "running", updatedAt: NOW - STALE_MS * 5 } }),
		facts({ record: { state: "retired" } }),
		facts(),
		// R2's exact regression: a settled node whose ledger row froze at
		// `starting` because the child died (heartbeats stop on death).
		facts({
			record: { state: "settled" },
			ledger: { status: "starting", updatedAt: NOW - STALE_MS * 3 },
		}),
	];
	for (const [index, caseFacts] of cases.entries()) {
		const first = liveness(caseFacts);
		const answers = new Set<Liveness>();
		for (let i = 0; i < 100; i += 1) answers.add(liveness(caseFacts));
		assert.deepEqual(
			[...answers],
			[first],
			`facts #${index} must project to one answer 100 times, got ${[...answers].join("/")}`,
		);
	}
});

test("A2: a settled record with a frozen `starting` ledger row reads dead, never live (R2 regression)", () => {
	// Rule 6 fires before rule 7 and both say dead; the assertion that matters is
	// that no ordering of these facts can produce `live`, so the rail cannot pull
	// a finished node back to running (contract R2, W1 half of A2).
	const settledFacts = facts({
		record: { state: "settled" },
		ledger: { status: "starting", updatedAt: NOW - STALE_MS * 3 },
	});
	const verdict = liveness(settledFacts);
	assert.equal(verdict, "dead");
	// Advancing the render clock must not resurrect it either.
	for (const later of [NOW + 1, NOW + STALE_MS, NOW + STALE_MS * 1000]) {
		assert.equal(liveness({ ...settledFacts, now: later }), "dead");
	}
});

// ── A4: D5 state mapping ─────────────────────────────────────────────────

test("A4: idle → idle, queued → queued, undefined → unknown", () => {
	assert.equal(displayStatusFromState("idle"), "idle");
	assert.equal(displayStatusFromState("queued"), "queued");
	assert.equal(displayStatusFromState(undefined), "unknown");
});

test("A4: the rest of the D5 table maps as specified, with no retired fallback", () => {
	const table: Array<[string | undefined, string]> = [
		["starting", "running"],
		["working", "running"],
		["running", "running"],
		["blocked", "running"],
		["settled", "settled"],
		["success", "settled"],
		["completed", "settled"],
		["done", "settled"],
		["failed", "failed"],
		["aborted", "failed"],
		["error", "failed"],
		["truncated", "failed"],
		["retired", "retired"],
		["awaiting", "unknown"],
		["exited", "unknown"],
		["", "unknown"],
	];
	for (const [input, expected] of table) {
		assert.equal(displayStatusFromState(input), expected, `displayStatusFromState(${String(input)})`);
	}
	// D5 explicitly forbids the old `return "retired"` catch-all.
	assert.equal(displayStatusFromState("some-new-state"), "unknown");
});

test("A4: idle and queued are alive states, not terminal ones (D5 slot semantics)", () => {
	// An idle child still holds a concurrency slot and a queued child is admitted
	// but unstarted: both are non-terminal, so a live handle stays live.
	assert.equal(NON_TERMINAL.has("idle"), true);
	assert.equal(NON_TERMINAL.has("queued"), true);
	assert.equal(TERMINAL_STATES.has("idle"), false);
	assert.equal(TERMINAL_STATES.has("queued"), false);
	assert.equal(liveness(facts({ inMemory: { state: "idle" } })), "live");
	assert.equal(liveness(facts({ inMemory: { state: "queued" } })), "live");
	// A fresh heartbeat on an idle child is likewise live, not dead.
	assert.equal(liveness(facts({ ledger: { status: "idle", updatedAt: NOW } })), "live");
});

test("terminal sets: TERMINAL_STATES matches the contract list, and isTerminalState is total", () => {
	assert.deepEqual(
		[...TERMINAL_STATES].sort(),
		["aborted", "completed", "done", "error", "failed", "retired", "settled", "success", "truncated"],
	);
	for (const state of TERMINAL_STATES) assert.equal(isTerminalState(state), true, state);
	for (const state of NON_TERMINAL) assert.equal(isTerminalState(state), false, state);
	assert.equal(isTerminalState(undefined), false);
	assert.equal(isTerminalState(""), false);
});

// ── §7-7 / D1: purity, asserted by reading the module ───────────────────

test("purity guard: liveness.ts reads no clock, no fs, no timer, no db (D1, §7-7)", () => {
	const source = readFileSync(
		path.resolve(import.meta.dirname, "../../src/extension/liveness.ts"),
		"utf8",
	);
	for (const forbidden of [
		"Date.now",
		"new Date",
		"performance.now",
		"node:fs",
		'from "fs"',
		"node:path",
		"setTimeout",
		"setInterval",
		"node:timers",
		"./db.ts",
		"node:sqlite",
		"process.env",
		"Math.random",
	]) {
		assert.equal(source.includes(forbidden), false, `liveness.ts must not contain ${forbidden}`);
	}
	// It should also import nothing at all: the type surface is the whole module.
	assert.equal(/^\s*import\s/m.test(source), false, "liveness.ts must have no imports");
});
