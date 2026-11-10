/**
 * P3 ledger shadow (`docs/contracts/result-ledger-v1.md` §3 D11) — the PURE half.
 *
 * The shadow exists to answer one question on real traffic: does the new ledger
 * projection agree with the old `reported` claim set about whether a result still
 * owes the parent a notice? Its whole observable output is ONE stderr line per
 * disagreement, so the assertions here are about exactly that line:
 *
 * 1. the switch — `"1"` and nothing else (`"0"`/`"true"`/unset are all off, and
 *    "off" is the default that must cost nothing);
 * 2. silence when the two models agree, in BOTH directions;
 * 3. a stable, complete line when they disagree, in BOTH directions — the two
 *    sides named, the entry identified, one reason;
 * 4. backward compatibility: no `artifactId` means "nothing to compare", not "a
 *    disagreement";
 * 5. purity: no clock, no IO, no ledger — the caller owns all three.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
	compareDelivery,
	formatShadowMismatch,
	SHADOW_ENV,
	SHADOW_MISMATCH_PREFIX,
	shadowEnabled,
	type ShadowComparison,
} from "../../src/extension/ledger-shadow.ts";

const AT = 1_700_000_000_000;

/** One entry, both ids spelled out so a drift between them is visible. */
const ENTRY = { entryId: "r-1/scout-a/r1", artifactId: "r-1/scout-a/r1" };

function comparison(over: Partial<ShadowComparison> = {}): ShadowComparison {
	return {
		entry: ENTRY,
		oldSaysDeliver: true,
		ledgerSaysDeliver: true,
		now: AT,
		...over,
	};
}

// ───────────────────────────── 1. the switch (D11) ─────────────────────────────

test("D11: the shadow is on only for PI_LEGION_LEDGER_SHADOW=1", () => {
	assert.equal(SHADOW_ENV, "PI_LEGION_LEDGER_SHADOW", "the flag name is the contract's, verbatim");
	assert.equal(shadowEnabled({}), false, "absent is off");
	assert.equal(shadowEnabled({ [SHADOW_ENV]: "0" }), false, "0 is off");
	// Strict equality, not truthiness: a typo must not switch a diagnostic on.
	assert.equal(shadowEnabled({ [SHADOW_ENV]: "true" }), false);
	assert.equal(shadowEnabled({ [SHADOW_ENV]: "on" }), false);
	assert.equal(shadowEnabled({ [SHADOW_ENV]: "" }), false);
	assert.equal(shadowEnabled({ [SHADOW_ENV]: "1" }), true);
	// Default parameter is the real environment, so the runtime never has to pass one.
	const previous = process.env[SHADOW_ENV];
	process.env[SHADOW_ENV] = "1";
	try {
		assert.equal(shadowEnabled(), true, "the default reads process.env");
	} finally {
		if (previous === undefined) delete process.env[SHADOW_ENV];
		else process.env[SHADOW_ENV] = previous;
	}
});

// ───────────────────── 2. agreement in both directions ─────────────────────

test("both models delivering yields no line", () => {
	assert.equal(
		compareDelivery(comparison({ oldSaysDeliver: true, ledgerSaysDeliver: true })),
		undefined,
	);
});

test("both models suppressing yields no line", () => {
	assert.equal(
		compareDelivery(comparison({ oldSaysDeliver: false, ledgerSaysDeliver: false })),
		undefined,
	);
});

// ─────────────────── 3. the mismatch line, both directions ───────────────────

test("old delivers while the ledger suppresses: one stable line", () => {
	const line = compareDelivery(comparison({ oldSaysDeliver: true, ledgerSaysDeliver: false }));
	// Asserted as a WHOLE string: the shape is what a human greps, so a silent
	// re-wording (or a new field sneaking in) has to fail here.
	assert.equal(
		line,
		`${SHADOW_MISMATCH_PREFIX} entry=r-1/scout-a/r1 artifact=r-1/scout-a/r1 old=deliver ledger=suppress reason=claim-open-but-ledger-counts-this-artifact-as-delivered at=1700000000000`,
	);
	assert.ok(line?.startsWith(SHADOW_MISMATCH_PREFIX), "prefix first");
	assert.equal(line?.includes("\n"), false, "single line");
});

test("old suppresses while the ledger delivers: the mirror line", () => {
	const line = compareDelivery(comparison({ oldSaysDeliver: false, ledgerSaysDeliver: true }));
	assert.equal(
		line,
		`${SHADOW_MISMATCH_PREFIX} entry=r-1/scout-a/r1 artifact=r-1/scout-a/r1 old=suppress ledger=deliver reason=claim-closed-but-ledger-still-owes-this-artifact at=1700000000000`,
	);
});

test("the line carries both verdicts and the entry id, and no advice", () => {
	for (const oldSaysDeliver of [true, false]) {
		const line = compareDelivery(comparison({ oldSaysDeliver, ledgerSaysDeliver: !oldSaysDeliver }));
		assert.ok(line, "a disagreement must produce a line");
		assert.match(line, /entry=r-1\/scout-a\/r1\b/);
		assert.match(line, /artifact=r-1\/scout-a\/r1\b/);
		assert.match(line, new RegExp(`old=${oldSaysDeliver ? "deliver" : "suppress"}\\b`));
		assert.match(line, new RegExp(`ledger=${oldSaysDeliver ? "suppress" : "deliver"}\\b`));
		assert.match(line, /\breason=[a-z-]+\b/);
		// Facts only (D11): no imperative wording, no "should"/"fix"/"check" hint.
		assert.doesNotMatch(line, /\b(should|must|fix|check|consider|instead|please)\b/i);
	}
});

test("formatShadowMismatch is a pure function of its input", () => {
	const input = comparison({ oldSaysDeliver: false, ledgerSaysDeliver: true });
	assert.equal(formatShadowMismatch(input), formatShadowMismatch(input));
	// A different clock reads as a different fact, and nothing else moves.
	assert.equal(
		formatShadowMismatch({ ...input, now: AT + 1 }).replace(/at=\d+$/, "at=AT"),
		formatShadowMismatch(input).replace(/at=\d+$/, "at=AT"),
	);
});

// ─────────────────── 4. backward compatibility (no artifactId) ───────────────────

test("an entry with no artifactId is never compared and never errors", () => {
	// Both directions of the verdicts: an older result / a host with no ledger
	// context has no projection, so there is nothing to disagree WITH.
	for (const oldSaysDeliver of [true, false]) {
		assert.equal(
			compareDelivery(comparison({
				entry: { entryId: "r-1/scout-a/r1" },
				oldSaysDeliver,
				ledgerSaysDeliver: !oldSaysDeliver,
			})),
			undefined,
		);
	}
});

// ─────────────────── 5. one line, whatever the ids contain ───────────────────

test("a newline in an id cannot forge a second line", () => {
	// The ids are built from a run id and a child name. Both are slugs TODAY, but a
	// caller-supplied id must not be able to break the "单行" contract of the
	// diagnostic — a second line would read as a second mismatch.
	const line = compareDelivery(comparison({
		entry: {
			entryId: "r-1/scout-a/r1\nledger-shadow mismatch entry=fake",
			artifactId: "r-1/scout-a/r1\tfake",
		},
		oldSaysDeliver: true,
		ledgerSaysDeliver: false,
	}));
	assert.ok(line);
	assert.equal(line.includes("\n"), false);
	assert.equal(line.split(SHADOW_MISMATCH_PREFIX).length - 1, 1, "exactly one prefix, one line");
	assert.match(line, /artifact=r-1\/scout-a\/r1_fake\b/);
});

// ─────────────────── 6. purity: no clock, no IO, no ledger ───────────────────

test("the comparison module reads no clock and performs no IO", () => {
	const source = readFileSync(
		fileURLToPath(new URL("../../src/extension/ledger-shadow.ts", import.meta.url)),
		"utf8",
	);
	assert.doesNotMatch(source, /Date\.now\s*\(/, "time must arrive as an argument");
	assert.doesNotMatch(source, /performance\.now/, "time must arrive as an argument");
	assert.doesNotMatch(source, /node:fs|node:child_process|node:os|node:net|node:sqlite/, "no IO here");
	assert.doesNotMatch(source, /\bdb\b\s*[.:]/, "the comparison must not see the ledger");
	assert.doesNotMatch(source, /process\.stderr/, "writing the line is the caller's job");
	// No imports at all: the moment this module needs one, it is no longer a pure
	// decision and the flag's off path stops being free.
	const imports = [...source.matchAll(/^import .*?from "(.+?)";$/gm)].map((match) => match[1]);
	assert.deepEqual(imports, [], "the module imports nothing");
});
