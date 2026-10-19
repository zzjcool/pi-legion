/**
 * Session JSONL parse cost — the path `statusEntries()` walks once per job and
 * once per node on every 500ms refresh (`src/extension/runtime.ts`).
 *
 * Findings these numbers back (reports/perf-2026-10-19/REPORT.md, P7):
 *   `parseSessionFile` keeps an incremental offset cache (#36), but the exit
 *   still does `structuredClone(state.parsed)` — measured at ~106% of the warm
 *   call, i.e. the whole CPU saving of the incremental parse is spent copying.
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

test("structuredClone dominates the warm parse (the P7 lever)", () => {
	if (!hasRealArtifacts()) return;
	const [biggest] = realSessionFiles(1);
	assert.ok(biggest);
	clearSessionParseCache();
	const parsed = parseSessionFile(biggest.file);
	const cloneMs = medianMs(() => { structuredClone(parsed); }, 9);
	const warmMs = medianMs(() => { parseSessionFile(biggest.file); }, 9);

	// Not an assertion that clone > warm (it is close, and a fast box can flip
	// it): the point is clone is a *material* share, so a projection beats a
	// full deep copy. Assert the share is large enough to be worth fixing.
	const share = cloneMs / Math.max(warmMs, 1e-6);
	assert.ok(
		share > 0.25,
		`structuredClone is only ${(share * 100).toFixed(0)}% of the warm parse (${cloneMs.toFixed(2)}ms vs ${warmMs.toFixed(2)}ms); the P7 lever may be gone`,
	);
});

test("an empty or missing session file parses for free", () => {
	const warmMs = medianMs(() => { parseSessionFile("/nonexistent/definitely-not-here.jsonl"); }, 50);
	assert.ok(warmMs < 50, `missing-file parse took ${warmMs.toFixed(2)}ms`);
});

test("parseSessionFile is cheap enough to run per-node at 2Hz up to the LRU cap", () => {
	if (!hasRealArtifacts()) return;
	const files = realSessionFiles(8);
	assert.ok(files.length > 0);
	clearSessionParseCache();
	for (const f of files) parseSessionFile(f.file); // prime, as the first refreshUi would

	// One refreshUi pass over the tracked sessions must fit inside a 500ms tick
	// with room for the DB work that shares the tick.
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
