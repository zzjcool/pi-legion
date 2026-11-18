/**
 * Cross-machine worktrees and git-remote delivery (contract
 * `docs/contracts/cross-machine-spawn-v1.md` D10/D11/D12).
 *
 * The one fact this module exists to keep: a remote worktree is a path ON
 * ANOTHER MACHINE. Nothing here may be called with a path that lives on this
 * host, and nothing here may fall back to a local `git`/`fs` call — every
 * remote read and mutation is one `machine.exec{on}` round trip, and every
 * local `git` call is about THIS machine's checkout interpolating with that
 * machine's `origin`.
 *
 * Boundaries: pure logic (naming, path derivation, URL normalization) plus a
 * thin transport layer. Deliberately no dependency on the supervisor layer —
 * the terminal backend imports THIS, never the other way round — so the naming
 * and the failure classification can be unit-tested without a core.
 *
 * Git is restricted to the oldest useful subset (`rev-parse --git-dir`,
 * `remote get-url`, `worktree add -b`, `worktree remove --force`, `push`,
 * `fetch`, `rev-parse`, `test -d`). `--path-format` and every other
 * version-sensitive option stay out: `worktree.ts` already paid for that lesson
 * once (`isInsideChildWorktree`).
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { HcRpcError, type HcClient } from "../hc/client.ts";
import { ErrorCodes, SubagentError } from "../shared/types.ts";
import {
	ensureRemoteDir,
	execResultText,
	REMOTE_SETUP_TIMEOUT_S,
	type HcExecResult,
	type HostTarget,
} from "./remote.ts";
import { BOOTSTRAP_MODE_INSTALL, INSTALL_LOCKFILES, PROVISION_MARKER, installCommandForLockfile, resolveCommand } from "./provision.ts";
import { sanitizeNameForFs } from "./store.ts";
import { GIT_PROBE_TIMEOUT_MS, GIT_WORKTREE_TIMEOUT_MS } from "./worktree.ts";

/** One remote worktree: a path on `host`, checked out on `branch`. */
export interface RemoteWorktree {
	host: string;
	path: string;
	branch: string;
}

/**
 * Budget for `machine.exec` calls that MUTATE a remote tree. `hc` caps `timeout`
 * at 600 s, so the local `git worktree add` budget (120 s) travels unchanged and
 * is always under the cap.
 */
export const REMOTE_WORKTREE_TIMEOUT_S = Math.ceil(GIT_WORKTREE_TIMEOUT_MS / 1000);

/** Attempts for `git worktree add -b`, mirroring `createChildWorktree`'s five. */
const WORKTREE_ADD_ATTEMPTS = 5;

/** How much of a remote stderr one error message carries. */
const STDERR_CLIP = 500;

// ── naming (D12) ───────────────────────────────────────────────────────────

/**
 * Cross-machine branch: `pi-subagent/<host>/<name>-<hex8>`.
 *
 * The host segment is what makes the branch unique against the shared `origin`
 * (D12): two machines dispatching the same child name would otherwise race for
 * one ref, and the parent could not tell whose work it just fetched. The local
 * spelling (`worktreeBranchFor`, `pi-subagent/<name>-<hex8>`) is deliberately
 * NOT touched — no existing run's MR changes.
 *
 * Both segments are filtered to what git accepts in a ref: the name goes through
 * the same `sanitizeNameForFs` the local branch uses, plus a ref-specific pass
 * (`..`, a `.lock` tail, `@{`, and the characters git forbids).
 */
export function remoteWorktreeBranchFor(host: string, name: string, nonce?: string): string {
	const tag = nonce ?? randomBytes(4).toString("hex");
	return `pi-subagent/${sanitizeHostSegment(host)}/${sanitizeRefSegment(sanitizeNameForFs(name), "child")}-${sanitizeNonce(tag)}`;
}

/**
 * The host segment of a branch name: `[A-Za-z0-9._-]` and nothing else.
 *
 * Stricter than a git ref has to be, on purpose — this segment is also the part a
 * human reads in `git branch -r`, and an `on` name is an `hc` machine name, so a
 * `/` or a space there means somebody typed something that is not a machine name
 * (D12 says the segment is filtered, not escaped).
 */
function sanitizeHostSegment(host: string): string {
	const cleaned = (typeof host === "string" ? host : "")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[.-]+/, "")
		.replace(/[.-]+$/, "")
		.slice(0, 64);
	return cleaned.length > 0 ? cleaned : "host";
}

/** Characters git refuses anywhere in a ref; everything else becomes `-`. */
const ILLEGAL_REF_CHARS = /[\x00-\x20\x7f~^:?*[\\]/g;

/**
 * One ref path segment out of arbitrary text.
 *
 * `sanitizeNameForFs` already removed traversal and non-ASCII; what is left is
 * the git-specific domain: control/space and `~ ^ : ? * [ \` are illegal
 * anywhere, `..` and `@{` are illegal sequences, a `.lock` tail is illegal, and
 * a leading/trailing `.` is illegal at a component boundary.
 */
function sanitizeRefSegment(value: string, fallback: string): string {
	const cleaned = value
		.replace(ILLEGAL_REF_CHARS, "-")
		.replace(/\.{2,}/g, ".")
		.replace(/@\{/g, "-")
		.replace(/^[.-]+/, "")
		.replace(/[.-]+$/, "")
		.replace(/\.lock$/, "")
		.slice(0, 64);
	return cleaned.length > 0 ? cleaned : fallback;
}

/** The nonce is hex on the local path; a caller-supplied one is filtered too. */
function sanitizeNonce(nonce: string): string {
	const cleaned = nonce.replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
	return cleaned.length > 0 ? cleaned : randomBytes(4).toString("hex");
}

/**
 * Remote worktree destination: `<target.worktreeRoot>/<sanitized name>`.
 *
 * A sibling of the checkout by construction (`worktreeRoot`), so the tree is
 * never a path the child's own `git status` reports and never inside a repo it
 * commits to.
 */
export function remoteWorktreePathFor(target: HostTarget, name: string): string {
	return path.posix.join(target.worktreeRoot, sanitizeNameForFs(name));
}

// ── git remote identity (D10) ──────────────────────────────────────────────

/**
 * Normalize one `origin` URL so two spellings of the same remote compare equal.
 *
 * `git@host:org/repo.git`, `https://host/org/repo`, `ssh://git@host/org/repo/`
 * and `git://host/org/repo` all name the same place; a delivery channel that
 * refuses because the operator cloned over ssh on one machine and https on the
 * other would be wrong (D10 asks for "one shared remote", not "one URL string").
 * Host case is folded (DNS is case-insensitive) and the two syntactic coatings —
 * scheme + user info, and the `.git`/`/` tails — are removed.
 *
 * What is NOT folded: the path itself (case-sensitive, per host filesystem
 * conventions) and the host name. Those are the parts that make a clone a
 * DIFFERENT repository, which is the thing being checked.
 */
export function normalizeGitRemoteUrl(url: string): string {
	let value = (typeof url === "string" ? url : "").trim();
	if (value.length === 0) return "";
	// scp-like syntax (`user@host:path`) has no `//` and is not a URL; it is the
	// one shape whose separator is `:` rather than `/`.
	const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.*)$/.exec(value);
	if (scp) {
		return `${scp[1]!.toLowerCase()}/${trimRemotePath(scp[2]!)}`;
	}
	// scheme://[userinfo@]host[:port]/path
	const parsed = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:[^@/]+@)?([^/]+)\/(.*)$/.exec(value);
	if (parsed) {
		return `${parsed[2]!.toLowerCase()}/${trimRemotePath(parsed[3]!)}`;
	}
	// A bare `/abs/path` (a local-path remote, legal for git): keep the path as-is.
	if (value.startsWith("/")) return trimRemotePath(value);
	// Anything else (a relative local path): compare it verbatim, minus the tails.
	value = trimRemotePath(value);
	return value;
}

/** Strip the `.git` tail and the trailing slashes a clone URL may carry. */
function trimRemotePath(value: string): string {
	return value.replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
}

/**
 * The remote-tracking ref `origin/<branch>` as a string, for the two local
 * primitives below. Kept in one place so `fetchRemoteBranch` and
 * `remoteBranchTipOnOrigin` cannot disagree about which ref they mean.
 */
function trackingRef(branch: string): string {
	return `refs/remotes/origin/${branch}`;
}

/**
 * Fetch `branch` from `origin` into this checkout and answer the sha.
 *
 * This is the parent's half of D10's delivery channel: the remote child pushes
 * the branch from ITS machine (it has the credentials there), and this machine —
 * which already has the same `origin` — fetches it. An explicit refspec is used
 * rather than a bare `git fetch origin <branch>` so the remote-tracking ref is
 * guaranteed to exist afterwards (`branch -r` sees it); the resolved sha is the
 * same one the child put in its verdict.
 */
export async function fetchRemoteBranch(opts: { localRepo: string; branch: string }): Promise<{ sha: string }> {
	const branch = opts.branch.trim();
	if (branch.length === 0) {
		throw new SubagentError("fetchRemoteBranch needs a branch name", ErrorCodes.INVALID_PARAMS);
	}
	try {
		localGit(opts.localRepo, ["fetch", "origin", `+refs/heads/${branch}:${trackingRef(branch)}`]);
	} catch (error) {
		// An unpushed branch lands here, and that is a DELIVERY fact, not a git
		// curiosity: the child's work never reached the shared remote.
		throw new SubagentError(
			`cannot fetch '${branch}' from origin in ${opts.localRepo}: ${gitErrorText(error)}`,
			ErrorCodes.START_FAILED,
			{ branch, localRepo: opts.localRepo },
		);
	}
	const sha = localGit(opts.localRepo, ["rev-parse", trackingRef(branch)]).trim();
	if (sha.length === 0) {
		throw new SubagentError(
			`fetched '${branch}' from origin but could not resolve ${trackingRef(branch)}`,
			ErrorCodes.START_FAILED,
		);
	}
	return { sha };
}

/**
 * The sha `origin/<branch>` points at in THIS checkout, or `undefined` when the
 * branch was never fetched. Purely local: it reads the remote-tracking ref, so it
 * answers "what do I already have", never "what does the other machine have".
 */
export function remoteBranchTipOnOrigin(localRepo: string, branch: string): string | undefined {
	const name = (typeof branch === "string" ? branch : "").trim();
	if (name.length === 0) return undefined;
	try {
		const sha = localGit(localRepo, ["rev-parse", "--verify", "--quiet", trackingRef(name)]).trim();
		return sha.length > 0 ? sha : undefined;
	} catch {
		return undefined;
	}
}

/**
 * One local `git` call. `rev-parse`-sized probes get the probe budget, anything
 * else the worktree budget; both are the budgets `worktree.ts` already uses, so
 * a hung path costs one number this repository already knows how to read.
 */
function localGit(repo: string, args: readonly string[], timeoutMs = GIT_WORKTREE_TIMEOUT_MS): string {
	const probe = args[0] === "rev-parse" || args[0] === "remote";
	return execFileSync("git", ["-C", repo, ...args], {
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
		timeout: probe ? GIT_PROBE_TIMEOUT_MS : timeoutMs,
	});
}

/** git's own stderr first (it says WHY), then the message, then the bare error. */
function gitErrorText(error: unknown): string {
	if (error && typeof error === "object") {
		const { stderr, message } = error as { stderr?: Buffer | string | null; message?: unknown };
		const detail = stderr === undefined || stderr === null ? "" : String(stderr).trim();
		if (detail !== "") return detail.slice(0, STDERR_CLIP);
		if (typeof message === "string" && message !== "") return message;
	}
	return String(error);
}

// ── the transport layer (one `machine.exec` each) ──────────────────────────

/**
 * One `machine.exec` on the target, with the failure classification D14's
 * wording needs at every call site: a transport failure, a `timed_out` and a
 * missing exit code are facts about the MACHINE (`host '<h>' unreachable: …`) and
 * are never reported as a missing path or a git refusal.
 *
 * `stderr`/`stdout` arrive BASE64 on the real wire and are decoded here
 * (`execResultText`), so an error message carries git's own words.
 */
export async function remoteExec(
	client: HcClient,
	target: HostTarget,
	params: { argv?: string[]; line?: string; cwd?: string; timeout?: number },
	operation: string,
): Promise<HcExecResult> {
	let result: HcExecResult;
	try {
		result = await client.request<HcExecResult>("machine.exec", {
			on: target.host,
			...(params.argv ? { argv: params.argv } : {}),
			...(params.line ? { line: params.line } : {}),
			...(params.cwd ? { cwd: params.cwd } : {}),
			timeout: params.timeout ?? REMOTE_SETUP_TIMEOUT_S,
		});
	} catch (error) {
		throw new SubagentError(
			`host '${target.host}' unreachable: ${describeRemoteError(error)}`,
			ErrorCodes.START_FAILED,
			{ host: target.host },
		);
	}
	if (result?.timed_out === true) {
		throw new SubagentError(
			`host '${target.host}' unreachable: timed_out: ${operation} did not finish within ${params.timeout ?? REMOTE_SETUP_TIMEOUT_S}s (${execResultText(result) || "no output"})`,
			ErrorCodes.START_FAILED,
			// `timedOut` is what lets a SOFT caller tell "that machine answered, too
			// slowly" apart from "the round trip itself died" — both arrive here as one
			// `START_FAILED`. The preflight's `git ls-remote` step is soft on the first and
			// hard on the second (review M2), and re-parsing the prose to find out would be
			// a second, drifting answer.
			{ host: target.host, timedOut: true },
		);
	}
	if (typeof result?.code !== "number") {
		throw new SubagentError(
			`host '${target.host}' unreachable: no-exit-code: ${operation} returned no exit code (${execResultText(result) || "no output"})`,
			ErrorCodes.START_FAILED,
			{ host: target.host },
		);
	}
	return result;
}

/** `<kind>: <message>` when the core named a kind; the prose otherwise. */
function describeRemoteError(error: unknown): string {
	if (error instanceof HcRpcError) return `${error.kind}: ${error.message}`;
	if (error instanceof Error) return error.message;
	return String(error);
}

/** The one answer a state probe may give: yes / no / the machine is unusable. */
async function remotePathExists(
	client: HcClient,
	target: HostTarget,
	candidate: string,
	flag: "-d" | "-e" | "-f",
): Promise<boolean> {
	const result = await remoteExec(
		client,
		target,
		{ argv: ["test", flag, candidate] },
		`test ${flag} ${candidate}`,
	);
	if (result.code === 0) return true;
	// `test` answers 1 for "no" and >1 for "cannot tell". The spike measured the
	// missing-path case as a plain exit 1 (not an RPC error), which is why the
	// question is asked this way and not inferred from a failing `cd`.
	if (result.code === 1) return false;
	throw new SubagentError(
		`host '${target.host}': cannot test ${flag} ${candidate} (exit ${String(result.code)}: ${execResultText(result) || "no output"})`,
		ErrorCodes.START_FAILED,
		{ host: target.host, path: candidate },
	);
}

/**
 * Is `candidate` a directory on the target? The explicit preflight the spike
 * demanded: on a real core "cwd does not exist" and "program does not exist" are
 * the same `terminal.run` error, so the only way to tell an operator which one it
 * is, is to ask `test -d` before trying to start anything.
 *
 * Also the delivery preflight's third step (`cross-machine-preflight.ts`), which
 * reuses this instead of re-deriving the `code === 1` rule: a second copy of that
 * rule is how "no" and "cannot tell" collapse back together.
 */
export async function remotePathIsDirectory(
	client: HcClient,
	target: HostTarget,
	candidate: string,
): Promise<boolean> {
	return remotePathExists(client, target, candidate, "-d");
}

/**
 * `origin` of the remote checkout, or `undefined` when it has none.
 *
 * "No origin" is an ANSWER here (a checkout that was never cloned), not a
 * transport failure: `git remote get-url origin` exits non-zero for it, and the
 * caller words the two cases differently on purpose (D10).
 */
export async function remoteOriginUrl(
	client: HcClient,
	target: HostTarget,
	repoCwd: string,
): Promise<string | undefined> {
	const result = await remoteExec(
		client,
		target,
		{ argv: ["git", "-C", repoCwd, "remote", "get-url", "origin"] },
		`git -C ${repoCwd} remote get-url origin`,
	);
	if (result.code !== 0) return undefined;
	const url = decodeStdout(result).trim();
	return url.length > 0 ? url : undefined;
}

/** stdout only, decoded — for calls whose answer IS the output. */
function decodeStdout(result: HcExecResult): string {
	return execResultText({ stdout: result.stdout });
}

/**
 * One uniform tail so a checkout that is missing, broken or unreadable ends with
 * the SAME two ways out (contract D6).
 *
 * The failure on its own is a fact the operator cannot act on: a cross-machine
 * centurion delivers through a git worktree, so a machine without a usable
 * checkout cannot host one — but the launch can still happen locally, and the
 * cheapest correct answer is to say both options in one line instead of leaving
 * the reader to infer them. `<url>` stands for "whatever both sides can reach";
 * naming this checkout's origin here would need another git call on this host
 * before the order the contract froze has even looked at the remote.
 */
function checkoutTwoWaysOut(host: string, cwd: string): string {
	return (
		` Two ways out: 1) give that machine a checkout at ${cwd} — git clone <url> ${cwd} on '${host}' — or point ` +
		`subagents.crossMachine.hosts.${host}.cwd at a directory that is a git checkout; ` +
		"2) dispatch a worker instead (workers need no worktree and no git)."
	);
}

/** D6: the configured cwd does not exist on that machine. */
export function missingRemoteCheckoutMessage(host: string, cwd: string): string {
	return `host '${host}' has no checkout at ${cwd} (the configured cwd does not exist on that machine).${checkoutTwoWaysOut(host, cwd)}`;
}

/** D6: the cwd exists there but is not a git repository. */
export function notARepositoryMessage(host: string, cwd: string): string {
	return `host '${host}': ${cwd} is not a git repository on that machine.${checkoutTwoWaysOut(host, cwd)}`;
}

/**
 * D6: git itself is missing on the target machine.
 *
 * A separate message from "not a git repository" on purpose: `git worktree add`
 * cannot run at all there, so telling the operator their checkout is not a repo
 * (which `rev-parse --git-dir` also exits non-zero for) would send them to fix a
 * directory that is fine and leave the real missing program unnamed. Exit 127 is
 * the shell's "command not found" — with a real `git` on PATH it never happens.
 */
export function remoteGitMissingMessage(opts: { host: string; code: number | null; detail: string; command: string }): string {
	const detail = opts.detail.trim().slice(0, STDERR_CLIP) || "no output";
	const code = opts.code === null ? "no exit code" : String(opts.code);
	// Review m1: name the command that ACTUALLY ran. Two callers reach this with two
	// different commands (`git --version` at step 4, `git -C <cwd> rev-parse --git-dir`
	// at step 5 and in the worktree creator), and telling an operator `git --version`
	// failed when `rev-parse` is what ran sends them to test the wrong thing.
	return (
		`host '${opts.host}': git is not available on that machine (${opts.command} exited ${code}: ${detail}). ` +
		"A cross-machine centurion delivers through git worktrees, so git must be on PATH there. " +
		`Two ways out: 1) install git on '${opts.host}' and retry; 2) dispatch a worker instead (workers need no worktree and no git).`
	);
}

/**
 * D6: THIS checkout has no `origin`.
 *
 * The two ways out are asymmetric because the fix is: add a remote HERE (and make
 * sure that machine can reach the same url), or stop asking for a worktree — a
 * worker needs no origin at all. The `subagent(...)` call is spelled out complete
 * enough to paste, because "dispatch a worker instead" is not an instruction an
 * operator can follow without knowing the shape.
 */
export function noLocalOriginMessage(opts: { host: string; localRepo: string }): string {
	return (
		`cross-machine delivery needs one shared remote: this checkout (${opts.localRepo}) has no origin. ` +
		`Two ways out: 1) add one and retry — git -C ${opts.localRepo} remote add origin <url> ` +
		`(the machine '${opts.host}' must be able to reach the same url); ` +
		`2) drop the worktree delivery — dispatch a worker instead: subagent({ agent: "worker", host: "${opts.host}", task: "..." }) needs no origin.`
	);
}

/** D6: that machine's checkout has no `origin`. Fixable over there, so it says where. */
export function noRemoteOriginMessage(opts: { host: string; cwd: string; localOrigin: string }): string {
	return (
		`host '${opts.host}': ${opts.cwd} has no origin on that machine; cross-machine delivery needs one shared remote. ` +
		`Two ways out: 1) add one there — hc exec --on ${opts.host} -- git -C ${opts.cwd} remote add origin <url> ` +
		`(same url as this checkout's '${opts.localOrigin}'); 2) dispatch a worker instead (workers need no origin).`
	);
}

/** D6: both sides have an `origin`, and they are different remotes. Names BOTH urls. */
export function originMismatchMessage(opts: {
	host: string;
	cwd: string;
	remoteOrigin: string;
	localOrigin: string;
}): string {
	return (
		`host '${opts.host}': its checkout at ${opts.cwd} has origin '${opts.remoteOrigin}' but this checkout's is '${opts.localOrigin}'; ` +
		"cross-machine delivery needs one shared remote. " +
		"Two ways out: 1) make both sides point at one url (git remote set-url origin <url> on either side); " +
		"2) dispatch a worker instead (workers need no origin)."
	);
}

/**
 * Prove both checkouts point at the SAME `origin` before a tree is created (D10).
 *
 * Order matters for the message: "this checkout has no origin" is fixed here, on
 * this machine, by adding a remote; "that machine's checkout has no origin" is
 * fixed there. Then the different-remote case names BOTH urls, because the
 * operator has to decide which side is wrong.
 */
export async function assertSharedOrigin(opts: {
	client: HcClient;
	target: HostTarget;
	localRepo: string;
}): Promise<void> {
	const { client, target, localRepo } = opts;
	let localOrigin: string;
	try {
		localOrigin = localGit(localRepo, ["remote", "get-url", "origin"]).trim();
	} catch {
		localOrigin = "";
	}
	if (localOrigin.length === 0) {
		throw new SubagentError(noLocalOriginMessage({ host: target.host, localRepo }), ErrorCodes.INVALID_PARAMS, {
			host: target.host,
			localRepo,
		});
	}
	const remoteOrigin = await remoteOriginUrl(client, target, target.cwd);
	if (remoteOrigin === undefined) {
		throw new SubagentError(
			noRemoteOriginMessage({ host: target.host, cwd: target.cwd, localOrigin }),
			ErrorCodes.INVALID_PARAMS,
			{ host: target.host, cwd: target.cwd },
		);
	}
	if (normalizeGitRemoteUrl(localOrigin) !== normalizeGitRemoteUrl(remoteOrigin)) {
		throw new SubagentError(
			originMismatchMessage({
				host: target.host,
				cwd: target.cwd,
				remoteOrigin,
				localOrigin,
			}),
			ErrorCodes.INVALID_PARAMS,
			{ host: target.host, cwd: target.cwd, remoteOrigin, localOrigin },
		);
	}
}

// ── create / remove / provision ────────────────────────────────────────────

/**
 * Create the remote child's tree: `git worktree add -b <branch> <dest> HEAD` on
 * THAT machine (D11).
 *
 * The order is the contract: the checkout must exist (`test -d`), be a git
 * repository (`rev-parse --git-dir`), share this checkout's `origin` (D10), and
 * the destination must not exist (no reuse, no overwrite — a tree at that path
 * belongs to somebody, and silently taking it over is the one failure that
 * destroys work). Only then is a branch created, with the same five-attempt
 * retry the local path uses for the three transient git refusals.
 */
export async function createRemoteChildWorktree(opts: {
	client: HcClient;
	target: HostTarget;
	name: string;
	/**
	 * This machine's checkout for the same repository. Added to the frozen
	 * signature because {@link assertSharedOrigin} cannot answer "one shared
	 * remote" without both sides; the terminal backend (the only caller) always
	 * has it as `input.cwd`.
	 */
	localRepo: string;
	nonce?: string;
}): Promise<RemoteWorktree> {
	const { client, target, name, localRepo, nonce } = opts;
	if (!(await remotePathIsDirectory(client, target, target.cwd))) {
		throw new SubagentError(
			missingRemoteCheckoutMessage(target.host, target.cwd),
			ErrorCodes.INVALID_PARAMS,
			{ host: target.host, cwd: target.cwd },
		);
	}
	const probe = await remoteExec(
		client,
		target,
		{ argv: ["git", "-C", target.cwd, "rev-parse", "--git-dir"] },
		`git -C ${target.cwd} rev-parse --git-dir`,
	);
	if (probe.code !== 0) {
		// D6: 127 is the shell's "command not found" — git is absent there, which is
		// NOT "this directory is not a repository" and is fixed by installing git.
		if (probe.code === 127) {
			throw new SubagentError(
				remoteGitMissingMessage({
					host: target.host,
					code: 127,
					detail: execResultText(probe),
					command: `git -C ${target.cwd} rev-parse --git-dir`,
				}),
				ErrorCodes.INVALID_PARAMS,
				{ host: target.host, cwd: target.cwd, code: 127 },
			);
		}
		throw new SubagentError(
			notARepositoryMessage(target.host, target.cwd),
			ErrorCodes.INVALID_PARAMS,
			{ host: target.host, cwd: target.cwd, code: probe.code },
		);
	}
	await assertSharedOrigin({ client, target, localRepo });

	const dest = remoteWorktreePathFor(target, name);
	if (await remotePathExists(client, target, dest, "-e")) {
		throw new SubagentError(
			`host '${target.host}': worktree path ${dest} already exists on that machine (remove it there, or relaunch with a different name)`,
			ErrorCodes.INVALID_PARAMS,
			{ host: target.host, path: dest },
		);
	}

	let lastMessage = "";
	// `git worktree add` creates the final directory but not its parents, so the
	// root is asked for explicitly (the local path does the same with `mkdirSync`).
	await ensureRemoteDir(client, target, path.posix.dirname(dest));
	for (let attempt = 0; attempt < WORKTREE_ADD_ATTEMPTS; attempt += 1) {
		const branch = remoteWorktreeBranchFor(target.host, name, attempt === 0 ? nonce : undefined);
		const result = await remoteExec(
			client,
			target,
			{
				argv: ["git", "-C", target.cwd, "worktree", "add", "-b", branch, dest, "HEAD"],
				timeout: REMOTE_WORKTREE_TIMEOUT_S,
			},
			`git -C ${target.cwd} worktree add`,
		);
		if (result.code === 0) return { host: target.host, path: dest, branch };
		lastMessage = execResultText(result) || `exit ${String(result.code)}`;
		// Only the three refusals a retry can actually fix (a colliding branch or a
		// tree git itself just registered) are retried, exactly like the local path.
		if (!/already exists|already used|busy/i.test(lastMessage)) break;
	}
	throw new SubagentError(
		`host '${target.host}': git worktree add failed in ${target.cwd}: ${lastMessage.slice(0, STDERR_CLIP)}`,
		ErrorCodes.START_FAILED,
		{ host: target.host, cwd: target.cwd, path: dest },
	);
}

/**
 * Best-effort removal of a remote tree (rollback after a failed launch).
 *
 * Deliberately swallowing: this runs in a `catch` block, and replacing the real
 * reason a launch failed with a cleanup error is how the operator ends up fixing
 * the wrong thing. The caller logs the failure.
 */
export async function removeRemoteChildWorktree(opts: {
	client: HcClient;
	target: HostTarget;
	path: string;
}): Promise<void> {
	const { client, target, path: dest } = opts;
	try {
		await remoteExec(
			client,
			target,
			{
				argv: ["git", "-C", target.cwd, "worktree", "remove", "--force", dest],
				timeout: REMOTE_WORKTREE_TIMEOUT_S,
			},
			`git -C ${target.cwd} worktree remove`,
		);
	} catch {
		/* rollback is best effort: the launch error is the one worth reporting */
	}
}

/**
 * Provision a remote tree with the repo's own bootstrap mode (`worktreeBootstrap`).
 *
 * The command is resolved by `provision.ts`'s `resolveCommand` — the same parser
 * the local path uses, so "npm-install" means one thing in this repository. The
 * marker (`<tree>/.pi-provisioned`) is checked and written over the wire, and the
 * parent never stats a remote path.
 *
 * KNOWN S2 BOUNDARY: `resolveCommand` decides WHICH command `npm-install` means by
 * listing manifests on the local filesystem, which is the wrong machine for a
 * remote tree. A literal command (`worktreeBootstrap: "npm ci"`) is exact; the
 * manifest-detection refinement belongs with remote verify (S3).
 */
/**
 * `npm-install` on a REMOTE tree: which lockfile does it have, and therefore
 * which command runs? One `machine.exec` (a shell `[ -f ]` loop, no output
 * parsing beyond one filename), mapped through {@link installCommandForLockfile}.
 *
 * Returns `null` when the tree has no lockfile at all — the caller turns that
 * into a refusal, because "no lockfile" is not the same fact locally and
 * remotely and must never be recorded as "provisioned".
 */
async function remoteInstallCommand(
	client: HcClient,
	target: HostTarget,
	worktreePath: string,
): Promise<string | null> {
	const line = [
		`for f in ${INSTALL_LOCKFILES.join(" ")}; do`,
		`[ -f "$f" ] && { printf '%s' "$f"; exit 0; }`,
		"done",
		"exit 0",
	].join(" ; ");
	const result = await remoteExec(
		client,
		target,
		{ line, cwd: worktreePath, timeout: REMOTE_SETUP_TIMEOUT_S },
		"worktree bootstrap probe",
	);
	const name = execResultText(result).trim();
	if (name.length === 0) return null;
	const command = installCommandForLockfile(name);
	if (command === null) {
		throw new SubagentError(
			`host '${target.host}': unexpected lockfile '${name}' in ${worktreePath}`,
			ErrorCodes.START_FAILED,
			{ host: target.host, worktreePath, lockfile: name },
		);
	}
	return command;
}

export async function provisionRemoteWorktree(opts: {
	client: HcClient;
	target: HostTarget;
	worktreePath: string;
	mode?: string;
	timeoutMs?: number;
}): Promise<void> {
	const { client, target, worktreePath } = opts;
	const mode = (opts.mode ?? "").trim();
	if (!mode) return;
	const marker = path.posix.join(worktreePath, PROVISION_MARKER);
	if (await remotePathExists(client, target, marker, "-f")) return;
	// `npm-install` asks WHICH lockfile the tree has. Asking it here would be a
	// silent no-op: `resolveCommand` stats this machine's filesystem, and a remote
	// worktree path either does not exist here (every probe false → "nothing to
	// install", marker written, package manager never run) or, worse, exists and
	// belongs to something else. So the question goes to the machine that owns the
	// tree, and the answer maps through the same lockfile table the local path uses.
	const command = mode === BOOTSTRAP_MODE_INSTALL
		? await remoteInstallCommand(client, target, worktreePath)
		: resolveCommand(mode, worktreePath);
	if (!command) {
		if (mode === BOOTSTRAP_MODE_INSTALL) {
			throw new SubagentError(
				`host '${target.host}': cannot tell how to bootstrap ${worktreePath}: no ${INSTALL_LOCKFILES.join("/")} found on that machine; set the bootstrap to a literal command instead of '${BOOTSTRAP_MODE_INSTALL}'`,
				ErrorCodes.START_FAILED,
				{ host: target.host, worktreePath, mode },
			);
		}
		// A literal mode with nothing left to run is provisioned by definition —
		// the same answer the local path gives, recorded the same way so a resume
		// does not re-decide.
		await writeRemoteMarker(client, target, marker, mode);
		return;
	}
	const seconds = Math.min(
		Math.max(1, Math.ceil((opts.timeoutMs ?? 600_000) / 1000)),
		600,
	);
	const result = await remoteExec(
		client,
		target,
		{ line: command, cwd: worktreePath, timeout: seconds },
		`worktree bootstrap (${mode})`,
	);
	if (result.code !== 0) {
		throw new SubagentError(
			`host '${target.host}': worktree bootstrap failed (${mode}): ${(execResultText(result) || `exit ${String(result.code)}`).slice(0, STDERR_CLIP)}`,
			ErrorCodes.START_FAILED,
			{ host: target.host, worktreePath, mode },
		);
	}
	await writeRemoteMarker(client, target, marker, mode);
}

/** Write the idempotency marker with `file.write` (the parent owns the bytes). */
async function writeRemoteMarker(
	client: HcClient,
	target: HostTarget,
	marker: string,
	mode: string,
): Promise<void> {
	const payload = JSON.stringify({ mode, at: new Date().toISOString() });
	try {
		await client.request("file.write", {
			on: target.host,
			path: marker,
			data: Buffer.from(payload, "utf8").toString("base64"),
		});
	} catch (error) {
		throw new SubagentError(
			`host '${target.host}': cannot record the provision marker at ${marker}: ${describeRemoteError(error)}`,
			ErrorCodes.START_FAILED,
			{ host: target.host, marker },
		);
	}
}
