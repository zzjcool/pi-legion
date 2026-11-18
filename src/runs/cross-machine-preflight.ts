/**
 * Cross-machine delivery preflight (contract `cross-machine-demo-ux` D5/D6).
 *
 * The launch that produced this module failed like this: the caller asked for a
 * centurion on another machine, the phase machine validated, and only THEN did
 * the spawn refuse with `cross-machine delivery needs one shared remote: this
 * checkout has no origin` — a true sentence with no instruction in it, arriving
 * after the caller had already fixed something else. Two problems in one: the
 * check ran too late (the wiring is `orchestrator.ts`, D7, a separate change) and
 * the failure said what was wrong but not what to do.
 *
 * So this module is the ONE place that asks every question a cross-machine
 * delivery depends on, in a fixed order, against the machine that owns each
 * fact: `git` exists here, this checkout has an `origin`, the target's checkout
 * exists and is a repo, `git` exists there, that checkout has an `origin`, the
 * two `origin`s name one remote — and finally (softly) whether that remote is
 * actually reachable from there.
 *
 * Shape rules that are not negotiable:
 *
 *   - every hard failure is `ErrorCodes.INVALID_PARAMS` +
 *     `details.noModelFallback = true`. A missing `origin`, a target without
 *     `git` and an unreachable `hc` core are facts about a MACHINE, not about the
 *     model: walking the fallback chain would re-run every remote round trip
 *     against the same broken target per candidate and then report the last one's
 *     failure as the cause (`canFallbackStart` in `orchestrator.ts` already reads
 *     that flag).
 *   - the last step is a SOFT check. `git ls-remote origin` failing (no
 *     credentials there, a host that cannot resolve the name, a slow network) is
 *     recorded as `fetch: "unreachable"` and NOT thrown: the delivery still can
 *     succeed if the child's own push works, and refusing the launch over it
 *     would be the preflight deciding something it cannot know. A TRANSPORT
 *     failure (the `hc` round trip itself died) is still hard — that is the
 *     machine, and no git command can fix it.
 *   - the outcome is readable after the fact: `lastDeliveryPreflight()` is what
 *     `/legion doctor` renders, so a failure is recorded too (a doctor that can
 *     only show successes is useless exactly when it is needed).
 *
 * The wording of every hard failure is shared with the worktree creator
 * (`remote-worktree.ts`, D6) — both paths must refuse an unusable delivery with
 * the same sentence, or the same situation explains itself differently depending
 * on which one noticed first. Nothing here imports the orchestrator or the
 * supervisor layer: the preflight is called FROM them, and a dependency the other
 * way would be a cycle.
 */

import { execFileSync } from "node:child_process";
import type { HcClient } from "../hc/client.ts";
import { ErrorCodes, SubagentError } from "../shared/types.ts";
import {
	REMOTE_PREFLIGHT_TIMEOUT_S,
	execResultText,
	type HcExecResult,
	type HostTarget,
} from "./remote.ts";
import {
	missingRemoteCheckoutMessage,
	noLocalOriginMessage,
	noRemoteOriginMessage,
	normalizeGitRemoteUrl,
	notARepositoryMessage,
	originMismatchMessage,
	remoteExec,
	remoteGitMissingMessage,
	remoteOriginUrl,
	remotePathIsDirectory,
} from "./remote-worktree.ts";
import { GIT_PROBE_TIMEOUT_MS } from "./worktree.ts";

/** Everything the preflight needs: a core connection and the two checkouts. */
export interface DeliveryPreflightInput {
	client: HcClient;
	target: HostTarget;
	/** This machine's checkout for the same repository. */
	localRepo: string;
}

/**
 * Which fact failed. One name per step of the order below, plus `transport` for
 * "the machine never answered" — kept apart from the per-step names because it is
 * the only category that is about the CONNECTION rather than about a check.
 */
export type DeliveryPreflightCategory =
	| "local-git"
	| "local-origin"
	| "remote-checkout"
	| "remote-git"
	| "remote-origin"
	| "origin-mismatch"
	| "transport";

/** What the preflight concluded, and what it managed to check. */
export interface DeliveryPreflightReport {
	host: string;
	cwd: string;
	/** `Date.now()` of this run — doctor renders "n s ago" from it. */
	at: number;
	ok: boolean;
	/** Whether the target could reach `origin` (`git ls-remote origin`). */
	fetch: "ok" | "unreachable" | "skipped";
	/** git's own words when `fetch` is `unreachable`. */
	fetchDetail?: string;
	failure?: { category: DeliveryPreflightCategory; code: string; message: string };
}

/**
 * `git ls-remote`'s budget (D5 step 8). Ten seconds is the same rule the remote
 * preflight uses: a machine that cannot answer a trivial git question in ten
 * seconds is not one a launch should wait on — and this one does not refuse, so
 * the cost of being wrong is a slower start rather than a false refusal.
 */
const LS_REMOTE_TIMEOUT_S = 10;

/** How much of a remote stderr a failure detail carries (same cap as the messages). */
const DETAIL_CLIP = 500;

/**
 * The last run's outcome, on `globalThis` under `Symbol.for(...)`.
 *
 * A module-level `let` would be invisible to the other module instances in this
 * process: `/reload` and a cwd change clear pi's extension cache, and a child's
 * `--extension` load re-evaluates modules with `moduleCache: false`. Doctor may
 * run from a different instance than the one that launched, and a cache that
 * resets on re-evaluation would answer `never` for a launch that just failed —
 * exactly the wrong moment to forget. The same escape hatch is used by
 * `extension-inheritance.ts`, `supervisor/child-context.ts` and
 * `supervisor/admission-queue.ts`.
 *
 * Do NOT turn this into a module-level variable, and do not re-assign the holder
 * in {@link resetDeliveryPreflightState} — two instances would then point at two
 * different holders and the reset would silently stop working.
 */
const STORE_KEY = Symbol.for("pi-legion.delivery-preflight");

interface DeliveryPreflightStore {
	last?: DeliveryPreflightReport;
}

/** Symbol-indexed view of globalThis so the cache survives module re-evaluation. */
type StoreHolder = { [key: symbol]: DeliveryPreflightStore | undefined };

// SAFETY: `globalThis` is an object, so a `Symbol.for`-keyed property on it is
// readable; the only invariant TypeScript cannot check is that whoever wrote that
// slot first stored a `DeliveryPreflightStore`. Both sides live in this file.
const store = ((globalThis as unknown as StoreHolder)[STORE_KEY] ??= {});

/**
 * What this process last concluded about a cross-machine delivery, read-only.
 *
 * Pure in-memory read: no probe, no subprocess, no `hc` request. That is
 * deliberate — doctor must be able to report `never` without starting one.
 */
export function lastDeliveryPreflight(): DeliveryPreflightReport | undefined {
	return store.last;
}

/**
 * Reset the recorded outcome. Test seam only.
 *
 * Clears the holder's FIELD rather than replacing the holder: a replacement would
 * be invisible to every other module instance still pointing at the old object
 * (the failure mode the shared holder exists to prevent).
 */
export function resetDeliveryPreflightState(): void {
	delete store.last;
}

/** The two facts every step needs, captured once so a report cannot disagree. */
interface PreflightBase {
	host: string;
	cwd: string;
	at: number;
}

/**
 * Record a failed run and throw its error (D5: `INVALID_PARAMS` +
 * `noModelFallback`).
 *
 * `fetch: "skipped"` is right for every one of these: a hard failure stops the
 * order before the soft step, so "did the remote answer `ls-remote`" has no
 * answer — recording `unreachable` there would name the wrong fact.
 */
function fail(
	base: PreflightBase,
	category: DeliveryPreflightCategory,
	message: string,
	extra: Record<string, unknown> = {},
): never {
	const code = ErrorCodes.INVALID_PARAMS;
	store.last = {
		host: base.host,
		cwd: base.cwd,
		at: base.at,
		ok: false,
		fetch: "skipped",
		failure: { category, code, message },
	};
	throw new SubagentError(message, code, {
		host: base.host,
		category,
		...extra,
		// D5: a machine fact must not walk the model fallback chain.
		noModelFallback: true,
	});
}

/** One line of a result's own words, clipped, never empty. */
function detailOf(result: HcExecResult): string {
	const text = execResultText(result).trim();
	return text.length > 0 ? text.slice(0, DETAIL_CLIP) : "no output";
}

/**
 * `git --version` on THIS machine (step 1).
 *
 * Asked for the same reason the target's is: every step after it is a git
 * question, and "git is not installed here" reported as "this checkout has no
 * origin" is the kind of wrong answer this whole module exists to stop.
 */
function localGitVersion(): { ok: boolean; code: number | null; detail: string } {
	try {
		const stdout = execFileSync("git", ["--version"], {
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf8",
			timeout: GIT_PROBE_TIMEOUT_MS,
		});
		return { ok: true, code: 0, detail: stdout.trim() };
	} catch (error) {
		const status = (error as { status?: unknown }).status;
		return {
			ok: false,
			code: typeof status === "number" ? status : null,
			detail: localGitFailureText(error),
		};
	}
}

/** This checkout's `origin`, or `""` when it has none (step 2). */
function localOriginUrl(localRepo: string): string {
	try {
		const url = execFileSync("git", ["-C", localRepo, "remote", "get-url", "origin"], {
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf8",
			timeout: GIT_PROBE_TIMEOUT_MS,
		}).trim();
		return url;
	} catch {
		// "no origin" and "not a repository" are the same ANSWER here: neither
		// gives this checkout a remote a delivery could share (D5 step 2).
		return "";
	}
}

/** git's own stderr first (it says why), then the message, then the bare error. */
function localGitFailureText(error: unknown): string {
	if (error && typeof error === "object") {
		const { stderr, message } = error as { stderr?: Buffer | string | null; message?: unknown };
		const text = stderr === undefined || stderr === null ? "" : String(stderr).trim();
		if (text.length > 0) return text.slice(0, DETAIL_CLIP);
		if (typeof message === "string" && message.length > 0) return message.slice(0, DETAIL_CLIP);
	}
	return String(error).slice(0, DETAIL_CLIP);
}

/**
 * Refuse with `transport` when the `hc` round trip itself failed (never a
 * per-step category).
 *
 * `remoteExec`/`remoteOriginUrl`/`remotePathIsDirectory` already turned a dead
 * connection, a `timed_out` and a missing exit code into one `START_FAILED`
 * error. Re-classifying it here is the point: "that machine did not answer" is
 * per-machine, so it must stop the model fallback chain (`noModelFallback`), and
 * it must not be reported as a missing checkout — nobody can fix a path on a
 * machine they cannot reach.
 */
function transportFailure(base: PreflightBase, error: unknown, operation: string): never {
	const detail = error instanceof Error ? error.message : String(error);
	return fail(
		base,
		"transport",
		`host '${base.host}': the delivery preflight could not talk to that machine (${operation}): ${detail}`,
		{ operation },
	);
}

/**
 * Did the machine ANSWER, too slowly?
 *
 * `remoteExec` throws ONE `START_FAILED` for three different things, and the soft
 * step has to tell them apart (review M2): a `timed_out: true` result is a machine
 * that is there and slow — a network fact, exactly what D5 says is recorded, never
 * thrown. A dead round trip (`machine_unknown`, a closed socket, a missing exit
 * code) is a machine we cannot talk to at all, which stays hard.
 *
 * The flag is set where the result is read (`remote-worktree.ts`), not recovered
 * from the message: re-parsing prose here would be a second, drifting verdict on
 * the same fact.
 */
function timedOutOf(error: unknown): boolean {
	if (!(error instanceof SubagentError)) return false;
	const details = error.details as { timedOut?: unknown } | undefined | null;
	return details?.timedOut === true;
}

/**
 * Ask every question a cross-machine delivery depends on, in D5's fixed order,
 * and refuse at the first one with a fact to fix.
 *
 * The order is the contract (`docs/contracts/cross-machine-spawn-v1.md` D10/D11
 * freeze the same sequence for the worktree creator), and it is ordered by "what
 * can this reader fix": this machine's git, this checkout's origin, that
 * machine's checkout, its git, that it is a repo, its origin, that both name one
 * remote. A later question never runs after an earlier one failed, because its
 * answer would be a guess about a state that cannot be reached.
 *
 * Returns the report on success (fetch included) and records it for doctor.
 * Throws on every hard failure and records THAT too, so doctor can show what the
 * last attempt concluded either way.
 */
export async function preflightDelivery(input: DeliveryPreflightInput): Promise<DeliveryPreflightReport> {
	const { client, target, localRepo } = input;
	const base: PreflightBase = { host: target.host, cwd: target.cwd, at: Date.now() };

	// 1. git on THIS machine → local-git
	const git = localGitVersion();
	if (!git.ok) {
		const code = git.code === null ? "no exit code" : String(git.code);
		fail(
			base,
			"local-git",
			`this machine has no usable git (git --version exited ${code}: ${git.detail}); ` +
				"a cross-machine centurion delivers through git worktrees, so git must be on PATH here too. " +
				"Two ways out: 1) install git here and retry; " +
				`2) drop the worktree delivery — dispatch a worker instead: subagent({ agent: "worker", host: "${base.host}", task: "..." }) needs no worktree and no git.`,
			{ localRepo, code: git.code },
		);
	}

	// 2. this checkout's origin → local-origin
	const localOrigin = localOriginUrl(localRepo);
	if (localOrigin.length === 0) {
		fail(base, "local-origin", noLocalOriginMessage({ host: base.host, localRepo }), { localRepo });
	}

	// 3. the target's checkout exists → remote-checkout
	let checkoutIsDirectory: boolean;
	try {
		checkoutIsDirectory = await remotePathIsDirectory(client, target, target.cwd);
	} catch (error) {
		return transportFailure(base, error, `test -d ${target.cwd}`);
	}
	if (!checkoutIsDirectory) {
		fail(base, "remote-checkout", missingRemoteCheckoutMessage(base.host, base.cwd), { cwd: base.cwd });
	}

	// 4. git on THAT machine → remote-git (exit 127 / any non-zero)
	let gitVersion: HcExecResult;
	try {
		gitVersion = await remoteExec(
			client,
			target,
			{ argv: ["git", "--version"], timeout: REMOTE_PREFLIGHT_TIMEOUT_S },
			"git --version",
		);
	} catch (error) {
		return transportFailure(base, error, "git --version");
	}
	if (gitVersion.code !== 0) {
		const code = typeof gitVersion.code === "number" ? gitVersion.code : null;
		fail(
			base,
			"remote-git",
			remoteGitMissingMessage({
				host: base.host,
				code,
				detail: detailOf(gitVersion),
				command: "git --version",
			}),
			{ cwd: base.cwd, code },
		);
	}

	// 5. that checkout is a git repository → remote-checkout
	let gitDir: HcExecResult;
	try {
		gitDir = await remoteExec(
			client,
			target,
			{ argv: ["git", "-C", target.cwd, "rev-parse", "--git-dir"], timeout: REMOTE_PREFLIGHT_TIMEOUT_S },
			`git -C ${target.cwd} rev-parse --git-dir`,
		);
	} catch (error) {
		return transportFailure(base, error, `git -C ${target.cwd} rev-parse --git-dir`);
	}
	if (gitDir.code !== 0) {
		// 127 means the program is not there — the same fact step 4 names, never
		// "this directory is not a repository" (D6).
		if (gitDir.code === 127) {
			fail(
				base,
				"remote-git",
				remoteGitMissingMessage({
					host: base.host,
					code: 127,
					detail: detailOf(gitDir),
					command: `git -C ${target.cwd} rev-parse --git-dir`,
				}),
				{ cwd: base.cwd, code: 127 },
			);
		}
		fail(base, "remote-checkout", notARepositoryMessage(base.host, base.cwd), {
			cwd: base.cwd,
			code: gitDir.code,
		});
	}

	// 6. that checkout's origin → remote-origin
	let remoteOrigin: string | undefined;
	try {
		remoteOrigin = await remoteOriginUrl(client, target, target.cwd);
	} catch (error) {
		return transportFailure(base, error, `git -C ${target.cwd} remote get-url origin`);
	}
	if (remoteOrigin === undefined) {
		fail(base, "remote-origin", noRemoteOriginMessage({ host: base.host, cwd: base.cwd, localOrigin }), {
			cwd: base.cwd,
			localOrigin,
		});
	}

	// 7. one shared remote → origin-mismatch
	if (normalizeGitRemoteUrl(localOrigin) !== normalizeGitRemoteUrl(remoteOrigin)) {
		fail(
			base,
			"origin-mismatch",
			originMismatchMessage({
				host: base.host,
				cwd: base.cwd,
				remoteOrigin,
				localOrigin,
			}),
			{ cwd: base.cwd, remoteOrigin, localOrigin },
		);
	}

	// 8. (soft) can that machine reach it? → fetch: ok | unreachable
	const report: DeliveryPreflightReport = {
		host: base.host,
		cwd: base.cwd,
		at: base.at,
		ok: true,
		fetch: "ok",
	};
	try {
		const lsRemote = await remoteExec(
			client,
			target,
			{ argv: ["git", "-C", target.cwd, "ls-remote", "origin"], timeout: LS_REMOTE_TIMEOUT_S },
			`git -C ${target.cwd} ls-remote origin`,
		);
		if (lsRemote.code !== 0) {
			// D5: recorded, never thrown. The child pushes from THAT machine with its
			// own credentials; a parent-side `ls-remote` refusal (missing helper,
			// offline mirror) does not prove the push will fail, and refusing here
			// would turn a maybe into a definite.
			report.fetch = "unreachable";
			report.fetchDetail = detailOf(lsRemote);
		}
	} catch (error) {
		// A SLOW `ls-remote` is the soft outcome (review M2): the machine answered, so a
		// 10s budget says something about this network, not about the delivery. Refusing
		// here was the preflight contradicting its own `fetch: "unreachable"` rule — the
		// same situation reported as a hard `transport` failure just because git took
		// longer than the probe's budget. The child still pushes from THAT machine with
		// its own credentials, so a slow parent-side probe proves nothing.
		if (timedOutOf(error)) {
			report.fetch = "unreachable";
			report.fetchDetail = error instanceof Error ? error.message : String(error);
		} else {
			// ... but the round trip dying is the machine, and that is hard.
			return transportFailure(base, error, `git -C ${target.cwd} ls-remote origin`);
		}
	}

	store.last = report;
	return report;
}
