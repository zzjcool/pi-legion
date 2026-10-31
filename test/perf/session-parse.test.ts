/**
 * Session JSONL parse cost — what a status refresh pays when a session file HAS
 * changed.
 *
 * These are no longer the per-tick cost of the 500ms refresh
 * (`statusEntries()` in `src/extension/runtime.ts`). Since #348 that path goes
 * through `parseSessionFileCached` (`progressFromSessionFile`), which answers an
 * unchanged file from one `statSync` on `(path, size, mtimeMs)` and never calls
 * the parser at all — so the numbers below are the cost of a MISS (the first
 * tick after a write, i.e. at most once per file per write) plus the parse cost
 * that verdict readers still pay directly. The per-tick syscall profile is
 * asserted in `bench/perf-core/06-watch-tick.ts` (`statCalls`, `misses`), not
 * here: this file cannot see the gate from `parseSessionFile`.
 *
 * Findings these numbers back (reports/perf-2026-10-19/REPORT.md, P7):
 *   `parseSessionFile` keeps an incremental offset cache (#36), but the exit
 *   used to do `structuredClone(state.parsed)` — the returned-view deep copy
 *   cost ~2.2x a warm parse that skips it, so the incremental parse was given
 *   straight back. #237 replaced it with a minimal projection; the ratio guard
 *   below asserts that relationship rather than re-measuring the primitive.
 *
 * Uses real run artifacts when this checkout has them (they are gitignored and
 * absent on CI) and skips rather than asserting on an empty set.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

import { clearSessionParseCache, parseSessionFile } from "../../src/shared/session.ts";
import { hasRealArtifacts, medianMs, realSessionFiles, usPerOp } from "./fixtures.ts";

test("warm parse is far cheaper than a cold parse (the offset cache works)", () => {
	if (!hasRealArtifacts()) return; // no run artifacts in this checkout
	const [biggest] = realSessionFiles(1);
	assert.ok(biggest, "realSessionFiles(1) must yield an entry when hasRealArtifacts()");
	const { file, bytes } = biggest;

	clearSessionParseCache();
	const coldMs = medianMs(() => {
		clearSessionParseCache();
		parseSessionFile(file);
	}, 3);
	const warmMs = medianMs(() => { parseSessionFile(file); }, 9);

	// A cold parse reads the whole file; a warm one reads no new bytes.
	assert.ok(
		warmMs < coldMs,
		`warm (${warmMs.toFixed(3)}ms) should beat cold (${coldMs.toFixed(3)}ms) for ${(bytes / 1e6).toFixed(1)}MB`,
	);
	// Loose ceiling: 6.9MB measured ~75ms cold; 2s means the parser broke.
	assert.ok(coldMs < 2_000, `cold parse of ${(bytes / 1e6).toFixed(1)}MB took ${coldMs.toFixed(0)}ms`);
});

/**
 * Least-perturbed per-op cost (ms): min across samples of a tight loop. The
 * minimum, not the median, because every perturbation this box adds (a GC, an
 * fsync from a sibling process) only ever makes a sample slower. The guard
 * below compares two costs measured back-to-back, so a stable floor is what
 * makes the ratio meaningful.
 */
function bestPerOpMs(fn: () => void, iters: number, samples = 9): number {
	fn();
	let best = Number.POSITIVE_INFINITY;
	for (let s = 0; s < samples; s += 1) {
		const start = performance.now();
		for (let i = 0; i < iters; i += 1) fn();
		const per = (performance.now() - start) / iters;
		if (per < best) best = per;
	}
	return best;
}

test("a warm parse of a grown session stays well under a millisecond (the P7 guard)", () => {
	if (!hasRealArtifacts()) return;
	const [biggest] = realSessionFiles(1);
	assert.ok(biggest);
	// `parseSessionFile` re-derives the caller's view on EVERY poll (2 Hz per
	// node, under `refreshUi`). Pre-#237 that view was `structuredClone(state.parsed)`,
	// measured at ~2.2x the cost of a warm parse that does NOT deep-copy its own
	// result — i.e. the incremental offset cache (#36) bought a parse the view
	// copy immediately gave back. See the RATIO guard below for the real proof.
	//
	// Bound: 1.5ms for the single largest artifact (measured ~0.05ms warm here,
	// i.e. ~30x headroom for a slower box). This absolute backstop is deliberately
	// loose — the pre-fix clone alone also fits under it at realistic shapes —
	// so it only catches a catastrophic regression (e.g. re-reading the file),
	// never the copy-depth reversion. That is the RATIO guard's job.
	clearSessionParseCache();
	parseSessionFile(biggest.file); // prime, as the first refreshUi pass would
	const warmMs = medianMs(() => { parseSessionFile(biggest.file); }, 15);
	assert.ok(
		warmMs < 1.5,
		`warm parse of ${(biggest.bytes / 1e6).toFixed(1)}MB took ${warmMs.toFixed(3)}ms`,
	);

	// A status tick that has to parse (one miss, i.e. the first tick after a
	// write) covers 8 sessions; the following ticks cost one `stat` each and are
	// asserted in bench/perf-core/06-watch-tick.ts. This bound therefore still
	// holds for the expensive tick at 2 Hz.
	const files = realSessionFiles(8);
	clearSessionParseCache();
	for (const f of files) parseSessionFile(f.file);
	const passMs = medianMs(() => {
		for (const f of files) parseSessionFile(f.file);
	}, 5);
	assert.ok(passMs < 10, `a ${files.length}-session warm refresh pass took ${passMs.toFixed(2)}ms`);
});

/*
 * The actual P7 guard: a RATIO, not a ceiling.
 *
 * Both sides contain exactly one warm `parseSessionFile`; the only difference is
 * that the second one also `structuredClone`s its own result, i.e. it pays what
 * the pre-#237 code paid on every call. So the ratio isolates the cost of the
 * returned-view copy from everything else, and is therefore INDEPENDENT of
 * session shape, artifact size, and machine speed — which an absolute bound is
 * not. A revert to `structuredClone` collapses the ratio to ~2x (that is the
 * definition: the copy is one of the two copies a `parseSessionFile` leaves out
 * of the two parses being timed); the projection keeps it at ~7x.
 *
 * Measured on 4 real artifacts (14.8MB, 5 turns / 443 assistants), min-of-9
 * samples, aggregated over all four:
 *   projection  -> ratio 6.74x / 7.04x / 7.27x
 *   structuredClone -> ratio 2.16x / 2.21x / 2.20x
 * 4x sits ~1.8x clear of the revert and ~1.7x clear of the real code. The same
 * two numbers hold across synthetic shapes (150 / 400 / 2500 turns); shape
 * independence is the whole point.
 */
test("the returned-view copy costs far less than a clone of it (the P7 ratio guard)", () => {
	if (!hasRealArtifacts()) return;
	const files = realSessionFiles(4);
	assert.ok(files.length > 0);

	let parseTotal = 0;
	let withCloneTotal = 0;
	for (const { file } of files) {
		clearSessionParseCache();
		parseSessionFile(file); // prime, so both sides measure a warm parse
		parseTotal += bestPerOpMs(() => { parseSessionFile(file); }, 20);
		withCloneTotal += bestPerOpMs(() => { structuredClone(parseSessionFile(file)); }, 5);
	}

	const ratio = withCloneTotal / Math.max(parseTotal, 1e-9);
	assert.ok(
			parseTotal * 4 < withCloneTotal,
		`warm parse (${parseTotal.toFixed(4)}ms for ${files.length} artifacts) must be >4x cheaper than the same parse plus a structuredClone of its result (${withCloneTotal.toFixed(4)}ms); measured ratio ${ratio.toFixed(2)}x — the returned-view copy regressed toward a deep clone`,
	);
});

test("an empty or missing session file parses for free", () => {
	const warmMs = medianMs(() => { parseSessionFile("/nonexistent/definitely-not-here.jsonl"); }, 50);
	assert.ok(warmMs < 50, `missing-file parse took ${warmMs.toFixed(2)}ms`);
});

test("parseSessionFile is cheap enough to absorb the miss tick of every tracked node at 2Hz", () => {
	if (!hasRealArtifacts()) return;
	const files = realSessionFiles(8);
	assert.ok(files.length > 0);
	clearSessionParseCache();
	for (const f of files) parseSessionFile(f.file); // prime, as the first refreshUi would

	// The worst tick: every tracked session was written since the last poll, so
	// every one of them is a miss. It must still fit inside a 500ms tick with
	// room for the DB work that shares the tick.
	const passMs = medianMs(() => {
		for (const f of files) parseSessionFile(f.file);
	}, 5);
	assert.ok(
		passMs < 250,
		`a ${files.length}-session refresh pass took ${passMs.toFixed(1)}ms of the 500ms tick`,
	);
});

test("the parse cache keeps repeated polls off the filesystem", () => {
	if (!hasRealArtifacts()) return;
	const [first] = realSessionFiles(1);
	assert.ok(first);
	clearSessionParseCache();
	parseSessionFile(first.file);
	// Warm calls still open+fstat the file (that is the design), but must not
	// re-read the body: this guards the #36 incremental behaviour.
	const us = usPerOp(() => { parseSessionFile(first.file); }, 200);
	assert.ok(us < 20_000, `warm parse took ${us.toFixed(0)}us for ${(fs.statSync(first.file).size / 1e6).toFixed(1)}MB`);
});
