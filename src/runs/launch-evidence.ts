/**
 * #423 — did this child's launch actually PROVE it started?
 *
 * The defect this module names facts for: a cross-machine launch returned
 * success, the child never started on that machine, and every surface downstream
 * believed the parent's record instead of asking for evidence. Measured on
 * 2026-08 (@423, four children in one day): `run.json` with `updatedAt ==
 * createdAt`, no `remoteTerminal`, a 0-byte local transcript, nothing on the
 * target machine — and `subagent status` said `working` while the stall
 * detector counted it as "30 minutes without a tool in flight".
 *
 * Three surfaces had their own answer to "is it running", and all three could be
 * wrong in the same direction. This module is the one rule they share, so a
 * child that was never started cannot be called working by one of them and
 * unknown by another:
 *
 * ```
 * cross-machine child + no terminal address + no transcript  ⇒  never started
 * ```
 *
 * The two facts are exactly the ones a launch produces and a shell does not:
 *
 *   - `remoteTerminal` — the `host/name` address the core returned for the
 *     terminal it created. A launch that never got one never talked to the core,
 *     and one that got one exists in it (that is the thing a human can `hc read`);
 *   - a transcript with bytes — the child itself wrote something. A LOCAL child
 *     always has a pre-created (empty) placeholder at `sessionFile`, so bytes are
 *     what separates "the file the parent made" from "the child said something".
 *
 * A LOCAL child is `started` by definition here: its liveness is a pid on this
 * machine, which the supervisor answers directly (`isAlive`), and a missing
 * transcript there is "a turn that produced nothing" — a result, not a failed
 * launch. This rule is deliberately only about the cross-machine case, where the
 * parent has no process to look at and the record is all it will ever have.
 *
 * The RULE is pure (no clock, no I/O) so the three call sites cannot drift, and
 * the one file question it needs has exactly one implementation —
 * {@link transcriptBytesOf} — because `legion-tools` (a decision path) and the
 * status renderer (a display path) must not disagree about which file they read
 * or what "empty" means.
 */

import * as fs from "node:fs";

/** Facts a record/row can carry about one child's launch. */
export interface LaunchEvidenceFacts {
	/** Machine the child runs on; absent/empty = this host. */
	host?: string | null;
	/** `host/name` of the terminal the core really holds for it. */
	remoteTerminal?: string | null;
	/**
	 * Bytes of the transcript this host can see for the child.
	 *
	 * `0` means "the only file is the parent's empty placeholder" (or none at
	 * all): the child never wrote a byte, so no work happened.
	 */
	transcriptBytes?: number;
}

/** The answer, with the one fact that decided it (`undefined` for a local child). */
export interface LaunchEvidence {
	/** True when the launch proved it started (or the child is local). */
	started: boolean;
	/**
	 * Why, in the ONE spelling every surface prints:
	 *
	 *   - `local`       — not a cross-machine child; a pid answers liveness;
	 *   - `terminal`    — the core holds a terminal for it;
	 *   - `transcript`  — a transcript with bytes exists;
	 *   - `no-evidence` — neither of the two; the launch never proved anything.
	 */
	reason: "local" | "terminal" | "transcript" | "no-evidence";
}

/** `host` that means a real other machine, or `undefined` for this one. */
export function crossMachineHost(host: string | null | undefined): string | undefined {
	if (typeof host !== "string") return undefined;
	const trimmed = host.trim();
	if (trimmed.length === 0) return undefined;
	// `local` is a spelling the display layer uses for "this host" (#D3 of
	// display-liveness): a record carrying it is not a remote child.
	if (trimmed.toLowerCase() === "local") return undefined;
	return trimmed;
}

/** The one rule (see the module comment). */
export function launchEvidence(facts: LaunchEvidenceFacts): LaunchEvidence {
	const host = crossMachineHost(facts.host);
	if (host === undefined) return { started: true, reason: "local" };
	const terminal = typeof facts.remoteTerminal === "string" ? facts.remoteTerminal.trim() : "";
	if (terminal.length > 0) return { started: true, reason: "terminal" };
	const bytes = typeof facts.transcriptBytes === "number" && Number.isFinite(facts.transcriptBytes)
		? facts.transcriptBytes
		: 0;
	if (bytes > 0) return { started: true, reason: "transcript" };
	return { started: false, reason: "no-evidence" };
}

/** `true` for a cross-machine child whose launch never proved anything (#423). */
export function isUnstartedShell(facts: LaunchEvidenceFacts): boolean {
	return !launchEvidence(facts).started;
}

/**
 * The one sentence a surface prints for a shell, or `undefined` for a real child.
 *
 * Worded around the two missing facts rather than around a verdict, because that
 * is what the operator has to act on: `no terminal` says "the core never held it"
 * and `no transcript` says "nothing ran". Both are what `subagent status` has to
 * show instead of `working`.
 */
export function shellReason(facts: LaunchEvidenceFacts): string | undefined {
	if (!isUnstartedShell(facts)) return undefined;
	const host = crossMachineHost(facts.host) ?? "another host";
	const terminal = typeof facts.remoteTerminal === "string" ? facts.remoteTerminal.trim() : "";
	const bytes = typeof facts.transcriptBytes === "number" && Number.isFinite(facts.transcriptBytes)
		? facts.transcriptBytes
		: 0;
	if (terminal.length > 0) return undefined;
	return bytes > 0
		? `no terminal address recorded for ${host} (a transcript exists, so this is a record problem)`
		: `no terminal and no session on ${host}: the launch never proved it started`;
}

/**
 * Bytes of a transcript, or `0` when there is nothing to read.
 *
 * `0` is the only honest answer for both "the file is missing" and "the file is
 * the parent's empty placeholder": in both cases the child wrote nothing, and a
 * caller that needs to tell those apart has `fs.existsSync` for it. Never throws:
 * this is read on display and decision paths alike.
 */
export function transcriptBytesOf(file: string | null | undefined): number {
	if (typeof file !== "string" || file.length === 0) return 0;
	try {
		const stat = fs.statSync(file);
		return stat.isFile() ? stat.size : 0;
	} catch {
		return 0;
	}
}
