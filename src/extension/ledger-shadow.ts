/**
 * P3 "compressed shadow" — the PURE half of `PI_LEGION_LEDGER_SHADOW=1`.
 * Contract: `docs/contracts/result-ledger-v1.md` §3 D11 + §6 P3.
 *
 * The result ledger replaces the in-memory `reported` claim set, and a claim set
 * answers exactly one question: *does this result still owe the parent a notice?*
 * Getting that wrong is invisible — a notice that is silently swallowed turns no
 * test red — so before the old model is deleted (P4) the two answers are computed
 * side by side on real traffic and any DISAGREEMENT is written to stderr.
 *
 * ```
 * old side : !isReported(runId, name, round)          -- the claim set is open
 * new side : ledger.undelivered(consumerId) ∋ id      -- the projection has it
 * ```
 *
 * Both inputs arrive as arguments: this module reads no clock, opens no database
 * and knows nothing about `runtime.ts` internals (the same split as
 * `src/legion/stall-notice.ts`: pure decision + pure text, the caller does the
 * IO). That is what makes the line testable without a ledger, and what keeps the
 * flag's "off" path free of a single imported side effect.
 *
 * Facts only, never a suggestion: the line says which side said what and why they
 * differ. Deciding what to do about it is P4's job — deleting the old model — not
 * something a diagnostic may hint at.
 *
 * Lifetime: P3 only. P4 deletes this file together with the claim set (D11).
 */

/** The one environment variable that turns the shadow on. */
export const SHADOW_ENV = "PI_LEGION_LEDGER_SHADOW";

/**
 * The line prefix, exported because the assertion that matters (`no mismatch in
 * a real multi-child run`) greps stderr for this exact literal — one writer, one
 * spelling, no drift between the producer and the reader.
 */
export const SHADOW_MISMATCH_PREFIX = "ledger-shadow mismatch";

/**
 * What the shadow knows about one entry: its claim key and, when there is one,
 * the artifact the ledger projects.
 *
 * `entryId` is `"<runId>/<name>/r<round>"` — the claim key spelled the way a human
 * can correlate it, NOT the `\u0000`-joined literal the runtime uses (a NUL in a
 * log line is unusable). `artifactId` is `"<runId>/<segment>/r<round>"` as the
 * artifact store wrote it; absent on an older result or on a host with no ledger
 * context, which the comparison treats as "not comparable" instead of "different".
 */
export interface ShadowEntry {
	readonly entryId: string;
	readonly artifactId?: string;
}

/** Both verdicts, the entry they are about, and the caller's clock reading. */
export interface ShadowComparison {
	readonly entry: ShadowEntry;
	/**
	 * Old model: this result still owes a delivery (`!isReported(...)`).
	 *
	 * Passed in rather than read here: the claim set lives in the runtime closure
	 * and this module must not reach into it.
	 */
	readonly oldSaysDeliver: boolean;
	/**
	 * New model: `ledger.undelivered(consumerId)` contains `entry.artifactId`, i.e.
	 * the projection says this artifact was neither notified nor read to EOF.
	 *
	 * Also passed in, for the same reason: the caller owns the connection and the
	 * consumer id.
	 */
	readonly ledgerSaysDeliver: boolean;
	/** Host-clock reading of the comparison, for correlating with a session log. */
	readonly now: number;
}

/**
 * D11: the shadow exists only when the flag says `"1"`.
 *
 * Strict equality, not truthiness: `"0"`, `"true"`, `""` and `" yes"` are all OFF.
 * A diagnostic that can be switched on by a typo is a diagnostic that ships
 * enabled, and the contract freezes "默认零开销".
 *
 * `env` is a parameter (not a direct `process.env` read) so the switch itself is
 * testable without mutating the test process's environment.
 */
export function shadowEnabled(
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return env[SHADOW_ENV] === "1";
}

/**
 * The line to write, or `undefined` when there is nothing to say.
 *
 * Two ways to have nothing to say:
 *
 * - **the verdicts agree** — the only case on healthy traffic;
 * - **no `artifactId`** — an older result, or a host with no ledger context. A
 *   missing projection is not a disagreement: reporting it would make every
 *   ledger-less run noisy and would point at a defect that does not exist
 *   (backward compatibility, D11's shadow must never cry wolf).
 */
export function compareDelivery(input: ShadowComparison): string | undefined {
	if (input.entry.artifactId === undefined) return undefined;
	if (input.oldSaysDeliver === input.ledgerSaysDeliver) return undefined;
	return formatShadowMismatch(input);
}

/**
 * One stable, single-line fact about a disagreement.
 *
 * Shape (space-separated `key=value`, prefix first):
 *
 * ```
 * ledger-shadow mismatch entry=<runId>/<name>/r<round> artifact=<artifactId>
 *   old=<deliver|suppress> ledger=<deliver|suppress> reason=<phrase> at=<ms>
 * ```
 *
 * Every value is tokenised ({@link token}): the line is a contract ("单行"), and an
 * id is built from a run id and a child name — caller-supplied by definition — so
 * a stray newline must not be able to forge a second line in the diagnostic.
 */
export function formatShadowMismatch(input: ShadowComparison): string {
	return [
		SHADOW_MISMATCH_PREFIX,
		`entry=${token(input.entry.entryId)}`,
		`artifact=${token(input.entry.artifactId ?? "absent")}`,
		`old=${verdict(input.oldSaysDeliver)}`,
		`ledger=${verdict(input.ledgerSaysDeliver)}`,
		`reason=${reason(input)}`,
		`at=${token(String(input.now))}`,
	].join(" ");
}

/** `deliver` / `suppress` — the word each verdict is rendered as. */
function verdict(saysDeliver: boolean): "deliver" | "suppress" {
	return saysDeliver ? "deliver" : "suppress";
}

/**
 * Which way the two models point. Named from the OLD model's verdict because that
 * is the one being replaced: "the claim set is open" but the ledger already counts
 * the artifact as delivered, or the mirror image.
 *
 * The `verdicts-agree` branch is unreachable from {@link compareDelivery} (it
 * returns before formatting); it exists so a direct call cannot print a
 * mismatch-shaped line with a missing reason.
 */
function reason(input: ShadowComparison): string {
	if (input.oldSaysDeliver === input.ledgerSaysDeliver) return "verdicts-agree";
	return input.oldSaysDeliver
		? "claim-open-but-ledger-counts-this-artifact-as-delivered"
		: "claim-closed-but-ledger-still-owes-this-artifact";
}

/**
 * One whitespace/control-character-free token.
 *
 * Collapsing to `_` (rather than deleting) keeps the id recognisable: a name that
 * somehow contains a space still greps as itself with the space replaced.
 */
function token(value: string): string {
	return value.replace(/[\s\u0000-\u001f\u007f]+/g, "_");
}
