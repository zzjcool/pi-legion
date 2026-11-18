/**
 * Cross-machine worktrees (S2): naming, remote path derivation, `origin`
 * normalization, the ownership guard and every failure message of
 * `docs/contracts/cross-machine-spawn-v1.md` D10–D13.
 *
 * Everything here is pure logic or a recording fake client: no socket, no `hc`,
 * no second machine. The messages are asserted LITERALLY because they are the
 * contract: each one has to tell an operator which of "the machine is not
 * reachable", "the repo is not there" and "the path is not there" happened, and a
 * regex loose enough to accept a paraphrase would let those collapse again.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { HcRpcError, type HcClient, type HcMethod } from "../../src/hc/client.ts";
import {
	assertLocalWorktree,
	normalizeHost,
	resolveHostTarget,
	resolveResumeCwd,
	type HcExecResult,
	type HostTarget,
} from "../../src/runs/remote.ts";
import {
	assertSharedOrigin,
	createRemoteChildWorktree,
	fetchRemoteBranch,
	localCheckoutState,
	noLocalGitMessage,
	normalizeGitRemoteUrl,
	notALocalCheckoutMessage,
	provisionRemoteWorktree,
	remoteBranchTipOnOrigin,
	remoteOriginUrl,
	remotePathIsDirectory,
	remoteWorktreeBranchFor,
	remoteWorktreePathFor,
	removeRemoteChildWorktree,
	type LocalCheckoutState,
} from "../../src/runs/remote-worktree.ts";
import { worktreeBranchFor } from "../../src/runs/worktree.ts";
import { ErrorCodes, SubagentError } from "../../src/shared/types.ts";

// ── fixtures ───────────────────────────────────────────────────────────────

type Params = Record<string, unknown>;

interface Call {
	method: HcMethod;
	params: Params;
}

/**
 * A protocol client that answers `machine.exec` through a per-call handler and
 * records every call, so "which command was asked" is assertable.
 */
class FakeRemoteClient implements HcClient {
	readonly calls: Call[] = [];
	/** Answers by argv[0..] prefix; the FIRST matching entry wins. */
	private readonly execHandlers: Array<{ match: (params: Params) => boolean; answer: () => unknown }> = [];
	writeAnswer: (() => unknown) | undefined;

	constructor() {
		// `mkdir -p <worktreeRoot>` precedes every `worktree add`; it is plumbing,
		// not the behaviour under test, so it answers 0 unless a test says otherwise.
		this.onArgv("mkdir -p", () => execResult({ code: 0 }));
	}

	onExec(match: (params: Params) => boolean, answer: () => unknown): this {
		this.execHandlers.push({ match, answer });
		return this;
	}

	/** Answer by the argv the target would run (`argv` joined with spaces). */
	onArgv(fragment: string, answer: () => unknown): this {
		return this.onExec((params) => Array.isArray(params.argv) && (params.argv as string[]).join(" ").includes(fragment), answer);
	}

	/** Answer by the shell `line` the target would run. */
	onLine(fragment: string, answer: () => unknown): this {
		return this.onExec((params) => typeof params.line === "string" && params.line.includes(fragment), answer);
	}

	async start(): Promise<void> {}
	async close(): Promise<void> {}

	async request<T = unknown>(method: HcMethod, params: Params = {}): Promise<T> {
		this.calls.push({ method, params });
		if (method === "file.write") {
			if (!this.writeAnswer) throw new Error("unexpected file.write");
			return this.writeAnswer() as T;
		}
		if (method !== "machine.exec") throw new Error(`unexpected method ${method}`);
		for (const handler of this.execHandlers) {
			if (handler.match(params)) return handler.answer() as T;
		}
		throw new Error(`no handler for ${JSON.stringify(params)}`);
	}

	execs(): Params[] {
		return this.calls.filter((call) => call.method === "machine.exec").map((call) => call.params);
	}
}

/** A `machine.exec` result carrying BASE64 streams, like the real core. */
function execResult(overrides: Partial<HcExecResult> = {}): HcExecResult {
	return { code: 0, ms: 2, signal: null, stdout: "", stderr: "", truncated: false, timed_out: false, ...overrides };
}

function base64(text: string): string {
	return Buffer.from(text, "utf8").toString("base64");
}

const HOST = "vps";
const REMOTE_CWD = "/srv/app";

/** A resolved target (the same resolver production uses), plus overrides. */
function target(overrides: Partial<HostTarget> = {}): HostTarget {
	return { ...resolveHostTarget(HOST, { enabled: true, hosts: { [HOST]: { cwd: REMOTE_CWD } } }), ...overrides };
}

/** A `HcRpcError` as the core sends it: the kind rides inside `data`. */
function rpcError(kind: string, message: string): HcRpcError {
	return new HcRpcError({ code: -32000, message, data: { kind } });
}

/** A local git checkout with `origin` set to `url` (or no origin when omitted). */
function localRepo(origin?: string): { root: string; repo: string; cleanup: () => void } {
	const root = mkdtempSync(path.join(tmpdir(), "remote-worktree-unit-"));
	const repo = path.join(root, "repo");
	mkdirSync(repo, { recursive: true });
	execFileSync("git", ["init", "-q", repo]);
	if (origin !== undefined) execFileSync("git", ["-C", repo, "remote", "add", "origin", origin]);
	return { root, repo, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** The message a rejected promise carries. */
async function refusal(promise: Promise<unknown>): Promise<SubagentError> {
	const error = await promise.then(() => undefined, (thrown: unknown) => thrown);
	assert.ok(error instanceof SubagentError, `expected a SubagentError, got ${String(error)}`);
	return error as SubagentError;
}

// ── naming (D12) ───────────────────────────────────────────────────────────

test("D12: a remote branch carries a host segment, a sanitized name and a hex tag", () => {
	const branch = remoteWorktreeBranchFor("vps", "child-1", "deadbeef");
	assert.equal(branch, "pi-subagent/vps/child-1-deadbeef");
	// Illegal characters in the host cannot produce an invalid ref.
	assert.equal(remoteWorktreeBranchFor("vps:prod/allowed space", "child 1", "0f0f0f0f"), "pi-subagent/vps-prod-allowed-space/child-1-0f0f0f0f");
	// A name that `sanitizeNameForFs` would emit with a `..` sequence is still a
	// legal ref (git refuses `..` anywhere in a ref name).
	assert.doesNotMatch(remoteWorktreeBranchFor("vps", "a..b", "c0ffee00"), /\.\./);
	assert.match(remoteWorktreeBranchFor("vps", "a..b", "c0ffee00"), /^pi-subagent\/vps\/a\.b-c0ffee00$/);
	// Without a nonce the tag is still 8 hex characters, so two launches never
	// collide on the shared origin by construction.
	assert.match(remoteWorktreeBranchFor("vps", "child-1"), /^pi-subagent\/vps\/child-1-[0-9a-f]{8}$/);
});

test("D12: the local branch spelling is untouched, and the two namespaces differ", () => {
	const local = worktreeBranchFor("child-1", "deadbeef");
	assert.equal(local, "pi-subagent/child-1-deadbeef", "the local branch must not move: no existing MR changes");
	assert.notEqual(remoteWorktreeBranchFor("vps", "child-1", "deadbeef"), local);
});

test("S2: the remote tree lives beside the checkout, never inside it", () => {
	const resolved = resolveHostTarget(HOST, { enabled: true, hosts: { [HOST]: { cwd: REMOTE_CWD } } });
	assert.equal(resolved.worktreeRoot, "/srv/.pi-worktrees", "default: dirname(cwd)/.pi-worktrees");
	const treePath = remoteWorktreePathFor(resolved, "root.centurion-0");
	assert.equal(treePath, "/srv/.pi-worktrees/root.centurion-0");
	const relative = path.posix.relative(REMOTE_CWD, treePath);
	assert.ok(relative.startsWith(".."), `the tree must not be under the checkout: ${relative}`);
	// A name with traversal or spaces cannot climb out of the root.
	assert.equal(remoteWorktreePathFor(resolved, "../../etc/passwd"), "/srv/.pi-worktrees/passwd");
	// A configured root is honoured, and only when it is absolute.
	assert.equal(
		resolveHostTarget(HOST, { enabled: true, hosts: { [HOST]: { cwd: REMOTE_CWD, worktreeRoot: "/data/trees" } } }).worktreeRoot,
		"/data/trees",
	);
	assert.throws(
		() => resolveHostTarget(HOST, { enabled: true, hosts: { [HOST]: { cwd: REMOTE_CWD, worktreeRoot: "trees" } } }),
		/must be absolute worktreeRoot|needs an absolute worktreeRoot/,
	);
});

// ── origin identity (D10) ──────────────────────────────────────────────────

test("D10: four spellings of one remote normalize to the same value", () => {
	const equivalent = [
		"git@github.com:acme/pi-legion.git",
		"https://github.com/acme/pi-legion",
		"ssh://git@github.com/acme/pi-legion/",
		"ssh://git@github.com/acme/pi-legion.git",
	];
	const normalized = equivalent.map(normalizeGitRemoteUrl);
	assert.deepEqual(new Set(normalized).size, 1, `all four must agree: ${JSON.stringify(normalized)}`);
	assert.equal(normalized[0], "github.com/acme/pi-legion");
});

test("D10: a different host or a different path is a different remote", () => {
	assert.notEqual(normalizeGitRemoteUrl("git@example.com:acme/pi-legion.git"), normalizeGitRemoteUrl("git@example.com:acme/fork.git"));
	assert.notEqual(normalizeGitRemoteUrl("git@example.com:acme/pi-legion.git"), normalizeGitRemoteUrl("git@gitlab.com:acme/pi-legion.git"));
	// The PATH stays case-sensitive even though the host does not.
	assert.notEqual(normalizeGitRemoteUrl("git@github.com:acme/Pi-Legion.git"), normalizeGitRemoteUrl("git@github.com:acme/pi-legion.git"));
});

// ── ownership guard (D13) ──────────────────────────────────────────────────

test("D13: a worktree owned by a host cannot be used as a local path", () => {
	const error = (() => {
		try {
			assertLocalWorktree({ worktreePath: "/srv/.pi-worktrees/x", worktreeHost: "vps" });
			return undefined;
		} catch (thrown) {
			return thrown;
		}
	})();
	assert.ok(error instanceof SubagentError);
	assert.equal((error as SubagentError).code, ErrorCodes.INVALID_PARAMS);
	assert.match((error as SubagentError).message, /\/srv\/\.pi-worktrees\/x/);
	assert.match((error as SubagentError).message, /'vps'/);
	// D5: an old record (no host fields at all) is LOCAL and is not refused.
	assert.doesNotThrow(() => assertLocalWorktree({ worktreePath: "/home/me/repo/worktrees/x" }));
	assert.doesNotThrow(() => assertLocalWorktree({ worktreePath: "/home/me/x", worktreeHost: null }));
	assert.doesNotThrow(() => assertLocalWorktree({ worktreePath: null, worktreeHost: "vps" }), "a host with no path guards nothing");
	assert.doesNotThrow(() => assertLocalWorktree({ worktreePath: "/home/me/x", worktreeHost: "  " }), "blank is local (D4)");
	assert.equal(normalizeHost(undefined), undefined);
});

// ── failure messages, literally (§D of the S2 card) ────────────────────────

test("D14: an unreachable machine is never reported as a missing path", async () => {
	for (const [thrown, kind] of [
		[rpcError("machine_unknown", "unknown machine: vps"), "machine_unknown"],
		[rpcError("timeout", "no reply"), "timeout"],
	] as const) {
		const client = new FakeRemoteClient().onArgv("test", () => {
			throw thrown;
		});
		const error = await refusal(remotePathIsDirectory(client, target(), REMOTE_CWD));
		assert.equal(error.code, ErrorCodes.START_FAILED);
		assert.equal(error.message, `host 'vps' unreachable: ${kind}: ${thrown.message}`);
	}
	// A timed-out `machine.exec` (the core killed the process) is the same class.
	const timedOut = new FakeRemoteClient().onArgv("test", () => execResult({ code: null, timed_out: true, stderr: base64("killed") }));
	const error = await refusal(remotePathIsDirectory(timedOut, target(), REMOTE_CWD));
	assert.equal(error.message, "host 'vps' unreachable: timed_out: test -d /srv/app did not finish within 30s (killed)");
	// ... and so is a result with no exit code at all.
	const noCode = new FakeRemoteClient().onArgv("test", () => execResult({ code: null }));
	assert.equal(
		(await refusal(remotePathIsDirectory(noCode, target(), REMOTE_CWD))).message,
		"host 'vps' unreachable: no-exit-code: test -d /srv/app returned no exit code (no output)",
	);
});

test("D10/D11: cwd missing, cwd not a repo, no origin, different origin — four exact messages", async () => {
	// 1. The checkout is not there (test -d answers 1).
	const missingCwd = new FakeRemoteClient().onArgv("test -d", () => execResult({ code: 1 }));
	const noCheckout = await refusal(createRemoteChildWorktree({ client: missingCwd, target: target(), name: "child", localRepo: "/tmp" }));
	assert.equal(noCheckout.code, ErrorCodes.INVALID_PARAMS);
	assert.equal(
		noCheckout.message,
		"host 'vps' has no checkout at /srv/app (the configured cwd does not exist on that machine). Two ways out: 1) give that machine a checkout at /srv/app — git clone <url> /srv/app on 'vps' — or point subagents.crossMachine.hosts.vps.cwd at a directory that is a git checkout; 2) dispatch a worker instead (workers need no worktree and no git).",
	);

	// 2. It exists but is not a git repository (rev-parse exits 128).
	const notRepo = new FakeRemoteClient()
		.onArgv("test -d", () => execResult({ code: 0 }))
		.onArgv("rev-parse --git-dir", () => execResult({ code: 128, stderr: base64("fatal: not a git repository") }));
	const notRepository = await refusal(createRemoteChildWorktree({ client: notRepo, target: target(), name: "child", localRepo: "/tmp" }));
	assert.equal(notRepository.code, ErrorCodes.INVALID_PARAMS);
	assert.equal(
		notRepository.message,
		"host 'vps': /srv/app is not a git repository on that machine. Two ways out: 1) give that machine a checkout at /srv/app — git clone <url> /srv/app on 'vps' — or point subagents.crossMachine.hosts.vps.cwd at a directory that is a git checkout; 2) dispatch a worker instead (workers need no worktree and no git).",
	);

	// 3. THIS checkout has no origin: fixed here, so the message does not blame the host.
	const local = localRepo();
	try {
		const remoteHasOrigin = new FakeRemoteClient()
			.onArgv("test -d", () => execResult({ code: 0 }))
			.onArgv("rev-parse --git-dir", () => execResult({ code: 0 }))
			.onArgv("remote get-url origin", () => execResult({ code: 0, stdout: base64("git@example.com:acme/pi-legion.git") }));
		const noLocalOrigin = await refusal(
			createRemoteChildWorktree({ client: remoteHasOrigin, target: target(), name: "child", localRepo: local.repo }),
		);
		assert.equal(noLocalOrigin.code, ErrorCodes.INVALID_PARAMS);
		assert.equal(
			noLocalOrigin.message,
			`cross-machine delivery needs one shared remote: this checkout (${local.repo}) has no origin. Two ways out: 1) add one and retry — git -C ${local.repo} remote add origin <url> (the machine 'vps' must be able to reach the same url); 2) drop the worktree delivery — dispatch a worker instead: subagent({ agent: "worker", host: "vps", task: "..." }) needs no origin.`,
		);

		// 4. THAT machine's checkout has no origin: fixed there, so it names the host.
		const withLocal = localRepo("git@example.com:acme/pi-legion.git");
		try {
			const remoteWithoutOrigin = new FakeRemoteClient()
				.onArgv("test -d", () => execResult({ code: 0 }))
				.onArgv("rev-parse --git-dir", () => execResult({ code: 0 }))
				.onArgv("remote get-url origin", () => execResult({ code: 2, stderr: base64("error: No such remote 'origin'") }));
			const noRemoteOrigin = await refusal(
				createRemoteChildWorktree({ client: remoteWithoutOrigin, target: target(), name: "child", localRepo: withLocal.repo }),
			);
			assert.equal(
				noRemoteOrigin.message,
				"host 'vps': /srv/app has no origin on that machine; cross-machine delivery needs one shared remote. Two ways out: 1) add one there — hc exec --on vps -- git -C /srv/app remote add origin <url> (same url as this checkout's 'git@example.com:acme/pi-legion.git'); 2) dispatch a worker instead (workers need no origin).",
			);

			// 5. Both have one, and they disagree: the message names BOTH.
			const differentOrigin = new FakeRemoteClient()
				.onArgv("test -d", () => execResult({ code: 0 }))
				.onArgv("rev-parse --git-dir", () => execResult({ code: 0 }))
				.onArgv("remote get-url origin", () => execResult({ code: 0, stdout: base64("git@example.com:acme/fork.git") }));
			const mismatch = await refusal(
				createRemoteChildWorktree({ client: differentOrigin, target: target(), name: "child", localRepo: withLocal.repo }),
			);
			assert.equal(
				mismatch.message,
				"host 'vps': its checkout at /srv/app has origin 'git@example.com:acme/fork.git' but this checkout's is 'git@example.com:acme/pi-legion.git'; cross-machine delivery needs one shared remote. Two ways out: 1) make both sides point at one url (git remote set-url origin <url> on either side); 2) dispatch a worker instead (workers need no origin).",
			);
		} finally {
			withLocal.cleanup();
		}
	} finally {
		local.cleanup();
	}
});

test("D6: `rev-parse` exiting 127 means git is missing there, not that the directory is not a repo", async () => {
	// The shell answers 127 when the program does not exist. Reporting that as "not
	// a git repository" sends the operator to fix a directory that is fine.
	const noGit = new FakeRemoteClient()
		.onArgv("test -d", () => execResult({ code: 0 }))
		.onArgv("rev-parse --git-dir", () => execResult({ code: 127, stderr: base64("sh: 1: git: not found") }));
	const error = await refusal(createRemoteChildWorktree({ client: noGit, target: target(), name: "child", localRepo: "/tmp" }));
	assert.equal(error.code, ErrorCodes.INVALID_PARAMS);
	assert.equal(
		error.message,
		"host 'vps': git is not available on that machine (git -C /srv/app rev-parse --git-dir exited 127: sh: 1: git: not found). A cross-machine centurion delivers through git worktrees, so git must be on PATH there. Two ways out: 1) install git on 'vps' and retry; 2) dispatch a worker instead (workers need no worktree and no git).",
	);
});

test("D5: one probe, four facts — checkout with origin, checkout without, not a checkout, no usable git", () => {
	// The collapse this pins: `catch { "" }` answered "no origin" for BOTH a
	// checkout that was never cloned and a directory that is not a repository, so a
	// real operator was told to `git remote add origin` where no repository exists.
	const withOrigin = localRepo("git@example.com:acme/pi-legion.git");
	const withoutOrigin = localRepo();
	const root = mkdtempSync(path.join(tmpdir(), "remote-worktree-local-state-"));
	try {
		assert.deepEqual(localCheckoutState(withOrigin.repo), { kind: "checkout", origin: "git@example.com:acme/pi-legion.git" });
		assert.deepEqual(localCheckoutState(withoutOrigin.repo), { kind: "checkout", origin: undefined });

		// git ANSWERED 128: the directory is not a checkout. A missing path is the
		// same answer — that is a fact about the path, not about the git binary.
		const plain = path.join(root, "agents");
		mkdirSync(plain, { recursive: true });
		assert.deepEqual(localCheckoutState(plain), { kind: "not-a-checkout" });
		assert.deepEqual(localCheckoutState(path.join(root, "absent")), { kind: "not-a-checkout" });

		const previousPath = process.env.PATH;
		const bin = path.join(root, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(path.join(bin, "git"), "#!/bin/sh\necho 'git: simulated failure' >&2\nexit 1\n", { mode: 0o755 });
		chmodSync(path.join(bin, "git"), 0o755);
		try {
			// A `git` that RUNS and refuses is still an answer about the directory:
			// `no-git` may only mean "the binary could not be started".
			process.env.PATH = bin;
			assert.deepEqual(localCheckoutState(plain), { kind: "not-a-checkout" }, "exit 1 is not no-git");

			// ENOENT: there is no git on PATH at all (the state assertSharedOrigin used
			// to report as "this checkout has no origin").
			const empty = path.join(root, "empty-path");
			mkdirSync(empty, { recursive: true });
			process.env.PATH = empty;
			const state = localCheckoutState(withOrigin.repo);
			assert.equal(state.kind, "no-git");
			const noGit = state as Extract<LocalCheckoutState, { kind: "no-git" }>;
			assert.equal(noGit.code, null, "a spawn failure has no exit code");
			assert.match(noGit.detail, /ENOENT/, "the spawn error's own words survive");
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	} finally {
		withOrigin.cleanup();
		withoutOrigin.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});

test("D5: a session directory that is NOT a checkout gets its own answer, never `git remote add`", async () => {
	// The real 6.2.0 session: cwd `/Users/me/agents`, not a repository. The old
	// message told the reader to add an `origin` there — impossible.
	const root = mkdtempSync(path.join(tmpdir(), "remote-worktree-not-a-checkout-"));
	try {
		const plain = path.join(root, "agents");
		mkdirSync(plain, { recursive: true });
		const client = new FakeRemoteClient()
			.onArgv("test -d", () => execResult({ code: 0 }))
			.onArgv("rev-parse --git-dir", () => execResult({ code: 0 }));
		const error = await refusal(
			createRemoteChildWorktree({ client, target: target(), name: "child", localRepo: plain }),
		);
		assert.equal(error.code, ErrorCodes.INVALID_PARAMS);
		// Full equality: the whole sentence is the contract (D5).
		assert.equal(error.message, notALocalCheckoutMessage({ host: HOST, localRepo: plain }));
		assert.equal(
			error.message,
			`cross-machine delivery needs a git checkout on this machine too, and this session's directory (${plain}) is not one. ` +
				"Two ways out: 1) run the launch from a checkout — start pi inside yours, or pass a relative cwd that points at one " +
				`plus hostCwd for the directory ON that machine: subagent({ agent: "centurion", host: "vps", cwd: "../my-repo", hostCwd: "/abs/path/on/vps", task: "..." }); ` +
				'2) dispatch a worker instead — subagent({ agent: "worker", host: "vps", task: "..." }) needs no checkout and no origin.',
		);
		// The impossible advice is GONE, not merely reordered.
		assert.doesNotMatch(error.message, /remote add/, "`git remote add` cannot work in a non-repository");
		assert.doesNotMatch(error.message, /has no origin/);
		// …and both ways out are pasteable shapes, not prose.
		// Both halves of the shape: a relative cwd alone would drop the remote directory
		// and send the reader into the D2 question next.
		assert.match(error.message, /subagent\(\{ agent: "centurion", host: "vps", cwd: "\.\.\/my-repo", hostCwd: "\/abs\/path\/on\/vps", task: "\.\.\." \}\)/);
		assert.match(
			error.message,
			/subagent\(\{ agent: "worker", host: "vps", task: "\.\.\." \}\) needs no checkout and no origin/,
		);
		// The remote half is never asked: the local fact already refuses.
		assert.equal(
			client.execs().some((params) => JSON.stringify(params.argv ?? []).includes("remote get-url")),
			false,
			"an origin question about that machine is not reached",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("D5: no git on THIS machine is its own answer, and the guard never asks that machine", async () => {
	// Before D5 this state reached `catch { localOrigin = "" }` and was reported as
	// "this checkout has no origin" — advice for a missing remote, given when the
	// program that would add one does not exist.
	const local = localRepo("git@example.com:acme/pi-legion.git");
	const root = mkdtempSync(path.join(tmpdir(), "remote-worktree-local-nogit-"));
	const previousPath = process.env.PATH;
	try {
		const empty = path.join(root, "empty-path");
		mkdirSync(empty, { recursive: true });
		process.env.PATH = empty;
		const state = localCheckoutState(local.repo);
		assert.equal(state.kind, "no-git");
		const noGit = state as Extract<LocalCheckoutState, { kind: "no-git" }>;
		const client = new FakeRemoteClient();
		const error = await refusal(assertSharedOrigin({ client, target: target(), localRepo: local.repo }));
		assert.equal(error.code, ErrorCodes.INVALID_PARAMS);
		assert.equal(
			error.message,
			noLocalGitMessage({ host: HOST, localRepo: local.repo, code: noGit.code, detail: noGit.detail }),
		);
		assert.match(error.message, /^this machine has no usable git \(git --version exited no exit code: /);
		assert.match(error.message, /install git here and retry/);
		assert.doesNotMatch(error.message, /has no origin/);
		assert.deepEqual(client.calls, [], "a local fact must not cost a round trip");
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		local.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});

test("D11: an existing destination is refused, and a failing add names cwd + git's own words", async () => {
	const local = localRepo("git@example.com:acme/pi-legion.git");
	try {
		const exists = new FakeRemoteClient()
			.onArgv("test -d", () => execResult({ code: 0 }))
			.onArgv("rev-parse --git-dir", () => execResult({ code: 0 }))
			.onArgv("remote get-url origin", () => execResult({ code: 0, stdout: base64("git@example.com:acme/pi-legion.git") }))
			.onArgv("test -e", () => execResult({ code: 0 }));
		const alreadyThere = await refusal(
			createRemoteChildWorktree({ client: exists, target: target(), name: "child", localRepo: local.repo }),
		);
		assert.equal(
			alreadyThere.message,
			"host 'vps': worktree path /srv/.pi-worktrees/child already exists on that machine (remove it there, or relaunch with a different name)",
		);

		const addFails = new FakeRemoteClient()
			.onArgv("test -d", () => execResult({ code: 0 }))
			.onArgv("rev-parse --git-dir", () => execResult({ code: 0 }))
			.onArgv("remote get-url origin", () => execResult({ code: 0, stdout: base64("git@example.com:acme/pi-legion.git") }))
			.onArgv("test -e", () => execResult({ code: 1 }))
			.onArgv("worktree add", () => execResult({ code: 128, stderr: base64("fatal: cannot create worktree") }));
		const addError = await refusal(
			createRemoteChildWorktree({ client: addFails, target: target(), name: "child", localRepo: local.repo }),
		);
		assert.equal(addError.code, ErrorCodes.START_FAILED);
		assert.equal(addError.message, "host 'vps': git worktree add failed in /srv/app: fatal: cannot create worktree");

		// The happy path: ONE `worktree add -b` with the remote branch and the remote path.
		const ok = new FakeRemoteClient()
			.onArgv("test -d", () => execResult({ code: 0 }))
			.onArgv("rev-parse --git-dir", () => execResult({ code: 0 }))
			.onArgv("remote get-url origin", () => execResult({ code: 0, stdout: base64("git@example.com:acme/pi-legion.git") }))
			.onArgv("test -e", () => execResult({ code: 1 }))
			.onArgv("worktree add", () => execResult({ code: 0 }));
		const tree = await createRemoteChildWorktree({ client: ok, target: target(), name: "child", nonce: "deadbeef", localRepo: local.repo });
		assert.deepEqual(tree, { host: "vps", path: "/srv/.pi-worktrees/child", branch: "pi-subagent/vps/child-deadbeef" });
		const add = ok.execs().find((params) => JSON.stringify(params.argv ?? []).includes("add"))!;
		assert.deepEqual(add.argv, ["git", "-C", "/srv/app", "worktree", "add", "-b", "pi-subagent/vps/child-deadbeef", "/srv/.pi-worktrees/child", "HEAD"]);
		assert.equal(add.timeout, 120, "the local 120s worktree budget travels unchanged");
	} finally {
		local.cleanup();
	}
});

test("D11: rollback and provision go over the wire and never touch this machine's fs", async () => {
	const client = new FakeRemoteClient()
		.onArgv("worktree remove", () => execResult({ code: 0 }))
		.onArgv("test -f", () => execResult({ code: 1 }))
		.onLine("npm", () => execResult({ code: 0 }));
	client.writeAnswer = () => ({ path: "/srv/.pi-worktrees/child/.pi-provisioned", bytes: 42 });
	await removeRemoteChildWorktree({ client, target: target(), path: "/srv/.pi-worktrees/child" });
	const remove = client.execs()[0]!;
	assert.deepEqual(remove.argv, ["git", "-C", "/srv/app", "worktree", "remove", "--force", "/srv/.pi-worktrees/child"]);

	await provisionRemoteWorktree({ client, target: target(), worktreePath: "/srv/.pi-worktrees/child", mode: "npm ci", timeoutMs: 60_000 });
	const execs = client.execs();
	assert.deepEqual(execs[1]!.argv, ["test", "-f", "/srv/.pi-worktrees/child/.pi-provisioned"]);
	assert.equal(execs[2]!.line, "npm ci");
	assert.equal(execs[2]!.cwd, "/srv/.pi-worktrees/child");
	assert.equal(execs[2]!.timeout, 60);
	const write = client.calls.find((call) => call.method === "file.write")!.params;
	assert.equal(write.on, "vps");
	assert.equal(write.path, "/srv/.pi-worktrees/child/.pi-provisioned");
	assert.match(Buffer.from(String(write.data), "base64").toString("utf8"), /"mode":"npm ci"/);

	// An existing marker is the whole idempotency: nothing is executed.
	const provisioned = new FakeRemoteClient().onArgv("test -f", () => execResult({ code: 0 }));
	await provisionRemoteWorktree({ client: provisioned, target: target(), worktreePath: "/srv/.pi-worktrees/child", mode: "npm ci" });
	assert.deepEqual(provisioned.execs().map((params) => params.argv), [["test", "-f", "/srv/.pi-worktrees/child/.pi-provisioned"]]);

	// hc caps `timeout` at 600s: a longer budget is clamped rather than sent.
	const clamped = new FakeRemoteClient()
		.onArgv("test -f", () => execResult({ code: 1 }))
		.onLine("npm", () => execResult({ code: 0 }));
	clamped.writeAnswer = () => ({ path: "x", bytes: 1 });
	await provisionRemoteWorktree({ client: clamped, target: target(), worktreePath: "/srv/.pi-worktrees/child", mode: "npm ci", timeoutMs: 3_600_000 });
	assert.equal(clamped.execs()[1]!.timeout, 600);

	// A remote no-op mode changes nothing (same answer the local path gives).
	const silent = new FakeRemoteClient();
	await provisionRemoteWorktree({ client: silent, target: target(), worktreePath: "/srv/.pi-worktrees/child" });
	assert.deepEqual(silent.calls, []);
});

test("D17: a missing remote tree on resume is named with the branch that survived", async () => {
	// This message lives in the terminal backend; the primitive underneath must
	// answer the question honestly (a non-directory is a NO, not an error).
	const client = new FakeRemoteClient().onArgv("test -d", () => execResult({ code: 1 }));
	assert.equal(await remotePathIsDirectory(client, target(), "/srv/.pi-worktrees/child"), false);
	const present = new FakeRemoteClient().onArgv("test -d", () => execResult({ code: 0 }));
	assert.equal(await remotePathIsDirectory(present, target(), "/srv/.pi-worktrees/child"), true);
});

test("D10: the two local delivery primitives read the remote-tracking ref", async (t) => {
	const root = mkdtempSync(path.join(tmpdir(), "remote-worktree-delivery-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const upstream = path.join(root, "origin.git");
	const clone = path.join(root, "clone");
	execFileSync("git", ["init", "-q", "--bare", upstream]);
	execFileSync("git", ["clone", "-q", upstream, clone]);
	execFileSync("git", ["-C", clone, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "one"]);
	execFileSync("git", ["-C", clone, "push", "-q", "origin", "HEAD:refs/heads/main"]);
	const head = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

	// The "other machine": a second clone pushes a branch. The FIRST clone must not
	// know about it — that is the state a parent is in when its remote child pushes.
	const other = path.join(root, "other");
	execFileSync("git", ["clone", "-q", upstream, other]);
	execFileSync("git", ["-C", other, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "child work"]);
	const branch = "pi-subagent/fakebox/child-1-deadbeef";
	execFileSync("git", ["-C", other, "push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
	const remoteHead = execFileSync("git", ["-C", other, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

	assert.equal(remoteBranchTipOnOrigin(clone, branch), undefined, "nothing fetched yet");
	assert.equal(remoteBranchTipOnOrigin(clone, ""), undefined);

	const fetched = await fetchRemoteBranch({ localRepo: clone, branch });
	assert.equal(fetched.sha, remoteHead);
	assert.equal(remoteBranchTipOnOrigin(clone, branch), remoteHead);
	assert.match(execFileSync("git", ["-C", clone, "branch", "-r"], { encoding: "utf8" }), new RegExp(`origin/${branch}`));
	assert.equal(remoteBranchTipOnOrigin(clone, "main"), head, "the other branch is still where it was");
	// An unpushed branch is a DELIVERY fact: the message names the branch and
	// carries git's own words instead of a bare ENOENT.
	const unpushed = await refusal(fetchRemoteBranch({ localRepo: clone, branch: "absent" }));
	assert.equal(unpushed.code, ErrorCodes.START_FAILED);
	assert.match(unpushed.message, /cannot fetch 'absent' from origin/);
});

// ── resume: an old record is local, a remote pair never becomes a local cwd ──

test("D5: an old run.json + old nodes row resumes on exactly today's local path", () => {
	// The pre-v4 shapes: no `host`, no `worktreeHost` ANYWHERE.
	const oldNode = { worktreePath: "/home/me/.pi-subagents/runs/r1/worktrees/child-1" };
	const oldSaved = { worktreePath: "/home/me/.pi-subagents/runs/r1/worktrees/child-1" };
	const oldParent = { worktreePath: null };
	const cwd = resolveResumeCwd({ node: oldNode, saved: oldSaved, parent: oldParent, parentRunCwd: "/home/me/repo", fallbackCwd: "/home/me/other" });
	assert.equal(cwd, "/home/me/.pi-subagents/runs/r1/worktrees/child-1", "the stored tree is the cwd, as before");
	// The old fallback chain, in order.
	assert.equal(resolveResumeCwd({ node: {}, saved: {}, parent: oldParent, parentRunCwd: "/home/me/repo", fallbackCwd: "/x" }), "/home/me/repo");
	// `??`, not `||`: an empty parent-run cwd still wins, exactly as the pre-contract
	// formula did (`parentRun.cwd ?? input.cwd`).
	assert.equal(resolveResumeCwd({ node: {}, saved: {}, parent: oldParent, parentRunCwd: "", fallbackCwd: "/x" }), "");
	assert.equal(
		resolveResumeCwd({ node: {}, saved: {}, parent: { worktreePath: "/home/me/parent-tree" }, parentRunCwd: "/home/me/repo", fallbackCwd: "/x" }),
		"/home/me/parent-tree",
		"a local parent tree still wins over the parent run cwd",
	);
});

test("D13: a remote worktree never becomes this process's resume cwd", () => {
	// The child's tree is on another machine: its remote path must not be used as a
	// local cwd, so the next candidate (the parent's local tree) answers instead.
	assert.equal(
		resolveResumeCwd({
			node: { worktreePath: "/srv/.pi-worktrees/child-1", worktreeHost: "vps" },
			saved: { worktreePath: "/srv/.pi-worktrees/child-1", worktreeHost: "vps" },
			parent: { worktreePath: "/home/me/parent-tree" },
			parentRunCwd: "/home/me/repo",
			fallbackCwd: "/x",
		}),
		"/home/me/parent-tree",
	);
	assert.equal(
		resolveResumeCwd({
			node: { worktreePath: "/srv/.pi-worktrees/child-1", worktreeHost: "vps" },
			saved: { worktreePath: "/srv/.pi-worktrees/child-1", worktreeHost: "vps" },
			parent: { worktreePath: null },
			parentRunCwd: "/home/me/repo",
			fallbackCwd: "/x",
		}),
		"/home/me/repo",
		"with no local parent tree the run's own cwd is still a local path",
	);
	// The pair is what decides, not the field's presence on one side only.
	assert.equal(
		resolveResumeCwd({ node: { worktreePath: "/srv/x" }, saved: { worktreeHost: "vps" }, parent: {}, parentRunCwd: "/home/me/repo", fallbackCwd: "/x" }),
		"/home/me/repo",
	);
});

test("D13: a REMOTE parent tree is refused by name instead of being used as a local cwd", () => {
	assert.throws(
		() => resolveResumeCwd({
			node: {},
			saved: {},
			parent: { worktreePath: "/srv/.pi-worktrees/parent", worktreeHost: "vps" },
			parentRunCwd: "/home/me/repo",
			fallbackCwd: "/x",
		}),
		(error: unknown) => {
			assert.ok(error instanceof SubagentError);
			assert.equal((error as SubagentError).code, ErrorCodes.INVALID_PARAMS);
			assert.match((error as SubagentError).message, /\/srv\/\.pi-worktrees\/parent/);
			assert.match((error as SubagentError).message, /'vps'/);
			return true;
		},
	);
});

test("D11: `npm-install` asks the OWNING machine which lockfile it has", async () => {
	// The bug this pins: `resolveCommand` stats THIS filesystem. Given a remote
	// worktree path it would find nothing, report "nothing to install" and write
	// the provision marker — a silent no-op on the one step that makes the tree
	// usable, recorded as success forever.
	const detected = new FakeRemoteClient()
		.onArgv("test -f", () => execResult({ code: 1 }))
		.onLine("pnpm-lock.yaml", () => ({ ...execResult({ code: 0 }), stdout: base64("package-lock.json") }))
		.onLine("npm ci", () => execResult({ code: 0 }));
	detected.writeAnswer = () => ({ path: "x", bytes: 1 });
	await provisionRemoteWorktree({
		client: detected,
		target: target(),
		worktreePath: "/srv/.pi-worktrees/child",
		mode: "npm-install",
		timeoutMs: 60_000,
	});
	const runs = detected.execs();
	// marker probe, lockfile probe, then the command the OTHER machine's lockfile implies
	assert.deepEqual(
		runs.find((params) => Array.isArray(params.argv) && params.argv[0] === "test")?.argv,
		["test", "-f", "/srv/.pi-worktrees/child/.pi-provisioned"],
	);
	const probe = runs.find((params) => typeof params.line === "string" && params.line.includes("pnpm-lock.yaml"));
	assert.ok(probe, "the lockfile question must be asked on that machine");
	assert.equal(probe.cwd, "/srv/.pi-worktrees/child");
	const install = runs.find((params) => params.line === "npm ci");
	assert.ok(install, "the lockfile answer must pick the install command");
	assert.equal(install.cwd, "/srv/.pi-worktrees/child");

	// A `pnpm` lockfile on that machine picks the pnpm command, same table.
	const pnpm = new FakeRemoteClient()
		.onArgv("test -f", () => execResult({ code: 1 }))
		.onLine("pnpm-lock.yaml", () => ({ ...execResult({ code: 0 }), stdout: base64("pnpm-lock.yaml") }))
		.onLine("pnpm install", () => execResult({ code: 0 }));
	pnpm.writeAnswer = () => ({ path: "x", bytes: 1 });
	await provisionRemoteWorktree({ client: pnpm, target: target(), worktreePath: "/srv/.pi-worktrees/child", mode: "npm-install" });
	assert.ok(pnpm.execs().some((params) => params.line === "pnpm install --frozen-lockfile"));
});

test("D11: no lockfile on that machine is a REFUSAL, never a written marker", async () => {
	const none = new FakeRemoteClient()
		.onArgv("test -f", () => execResult({ code: 1 }))
		.onLine("package-lock.json", () => execResult({ code: 0 }));
	none.writeAnswer = () => {
		throw new Error("a marker must not be written when nothing was provisioned");
	};
	await assert.rejects(
		() => provisionRemoteWorktree({ client: none, target: target(), worktreePath: "/srv/.pi-worktrees/child", mode: "npm-install" }),
		(error: unknown) => {
			assert.ok(error instanceof SubagentError);
			assert.equal((error as SubagentError).code, ErrorCodes.START_FAILED);
			assert.match((error as SubagentError).message, /cannot tell how to bootstrap/);
			assert.match((error as SubagentError).message, /literal command/);
			return true;
		},
	);
	// marker probe + lockfile probe only: no bootstrap command, no file.write.
	assert.equal(none.calls.filter((call) => call.method === "file.write").length, 0);
});
