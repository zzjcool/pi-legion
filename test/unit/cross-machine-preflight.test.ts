/**
 * The cross-machine delivery preflight (contract `cross-machine-demo-ux` D5/D6).
 *
 * What is pinned here and nowhere else:
 *
 *   - the EIGHT steps run in the frozen order, and a failure at step N stops the
 *     order (a later question about a state that cannot be reached would be a
 *     guess, and its answer would name the wrong fact);
 *   - every hard failure is `INVALID_PARAMS` + `details.noModelFallback = true`
 *     (`canFallbackStart` reads that flag: walking the model chain would re-run
 *     every remote round trip against the same broken machine);
 *   - the fetch step is SOFT — a non-zero `git ls-remote` is recorded, never
 *     thrown — while a transport failure inside it is still hard;
 *   - the last outcome (ok AND failed) is readable through
 *     `lastDeliveryPreflight()`, which is what doctor renders.
 *
 * The messages are asserted LITERALLY where they are the contract (D6): the point
 * of this change was that the old sentence stated a fact and offered nothing, so
 * a regex loose enough to accept a paraphrase would let the "nothing" come back.
 *
 * Everything is a recording fake client plus a real temporary git repo — no
 * socket, no `hc`, no second machine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { HcRpcError, type HcClient, type HcMethod } from "../../src/hc/client.ts";
import {
	lastDeliveryPreflight,
	preflightDelivery,
	resetDeliveryPreflightState,
	type DeliveryPreflightReport,
} from "../../src/runs/cross-machine-preflight.ts";
import { resolveHostTarget, type HcExecResult, type HostTarget } from "../../src/runs/remote.ts";
import {
	localCheckoutState,
	noLocalGitMessage,
	noLocalOriginMessage,
	notALocalCheckoutMessage,
} from "../../src/runs/remote-worktree.ts";
import { ErrorCodes, SubagentError } from "../../src/shared/types.ts";

// ── fixtures ───────────────────────────────────────────────────────────────

type Params = Record<string, unknown>;

interface Call {
	method: HcMethod;
	params: Params;
}

/**
 * A protocol client that answers `machine.exec` per handler and records every
 * call — the same construction `remote-worktree.test.ts` uses, so the two suites
 * cannot disagree about what a fake core looks like.
 */
class FakePreflightClient implements HcClient {
	readonly calls: Call[] = [];
	private readonly execHandlers: Array<{ match: (params: Params) => boolean; answer: () => unknown }> = [];

	onExec(match: (params: Params) => boolean, answer: () => unknown): this {
		this.execHandlers.push({ match, answer });
		return this;
	}

	/** Answer by the argv the target would run (`argv` joined with spaces). */
	onArgv(fragment: string, answer: () => unknown): this {
		return this.onExec(
			(params) => Array.isArray(params.argv) && (params.argv as string[]).join(" ").includes(fragment),
			answer,
		);
	}

	/**
	 * Same match as {@link onArgv}, checked BEFORE the earlier answers.
	 *
	 * A healthy client registers one answer per step; a test that needs step N to
	 * fail overrides exactly that answer, so "last registration wins" is the reading
	 * that keeps the fixture intact instead of silently re-answering the default.
	 */
	override(fragment: string, answer: () => unknown): this {
		this.execHandlers.unshift({
			match: (params) => Array.isArray(params.argv) && (params.argv as string[]).join(" ").includes(fragment),
			answer,
		});
		return this;
	}

	async start(): Promise<void> {}
	async close(): Promise<void> {}

	async request<T = unknown>(method: HcMethod, params: Params = {}): Promise<T> {
		this.calls.push({ method, params });
		if (method !== "machine.exec") throw new Error(`unexpected method ${method}`);
		for (const handler of this.execHandlers) {
			if (handler.match(params)) return handler.answer() as T;
		}
		throw new Error(`no handler for ${JSON.stringify(params)}`);
	}

	execs(): Params[] {
		return this.calls.filter((call) => call.method === "machine.exec").map((call) => call.params);
	}

	/** Every `machine.exec` as `argv.join(" ")`, in order: the order is the contract. */
	commands(): string[] {
		return this.execs().map((params) =>
			Array.isArray(params.argv) ? (params.argv as string[]).join(" ") : String(params.line ?? ""),
		);
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

/** A resolved target (the same resolver production uses). */
function target(overrides: Partial<HostTarget> = {}): HostTarget {
	return {
		...resolveHostTarget(HOST, { enabled: true, hosts: { [HOST]: { cwd: REMOTE_CWD } } }),
		...overrides,
	};
}

/** A local git checkout with `origin` set to `url` (or no origin when omitted). */
function localRepo(origin?: string): { root: string; repo: string; cleanup: () => void } {
	const root = mkdtempSync(path.join(tmpdir(), "cross-machine-preflight-unit-"));
	const repo = path.join(root, "repo");
	mkdirSync(repo, { recursive: true });
	execFileSync("git", ["init", "-q", repo]);
	if (origin !== undefined) execFileSync("git", ["-C", repo, "remote", "add", "origin", origin]);
	return { root, repo, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Every answer the happy path needs, all answering "one shared remote reachable
 * from both sides". Individual tests override one entry to fail exactly one step.
 */
function healthyClient(origin = "git@example.com:acme/pi-legion.git"): FakePreflightClient {
	return new FakePreflightClient()
		.onArgv("test -d", () => execResult({ code: 0 }))
		.onArgv("git --version", () => execResult({ code: 0, stdout: base64("git version 2.43.0") }))
		.onArgv("rev-parse --git-dir", () => execResult({ code: 0, stdout: base64(".git") }))
		.onArgv("remote get-url origin", () => execResult({ code: 0, stdout: base64(origin) }))
		.onArgv("ls-remote origin", () => execResult({ code: 0, stdout: base64("0123456789abcdef\tHEAD") }));
}

/** The message a rejected promise carries, with the D5 details checked once. */
async function hardFailure(promise: Promise<unknown>, category: string): Promise<SubagentError> {
	const error = await promise.then(() => undefined, (thrown: unknown) => thrown);
	assert.ok(error instanceof SubagentError, `expected a SubagentError, got ${String(error)}`);
	const failure = error as SubagentError;
	assert.equal(failure.code, ErrorCodes.INVALID_PARAMS, "D5: every hard failure is INVALID_PARAMS");
	const details = failure.details as { host?: unknown; category?: unknown; noModelFallback?: unknown } | undefined;
	assert.equal(details?.host, HOST);
	assert.equal(details?.category, category);
	assert.equal(details?.noModelFallback, true, "a machine fact must not walk the model fallback chain");
	return failure;
}

/** The report recorded for the last run, which doctor reads. */
function recorded(): DeliveryPreflightReport {
	const report = lastDeliveryPreflight();
	assert.ok(report, "the preflight must record its outcome, even when it fails");
	return report;
}

// ── the happy path ─────────────────────────────────────────────────────────

test("D5: the eight steps run in the frozen order and a reachable remote is `fetch: ok`", async () => {
	resetDeliveryPreflightState();
	const local = localRepo("git@example.com:acme/pi-legion.git");
	try {
		const client = healthyClient();
		const report = await preflightDelivery({ client, target: target(), localRepo: local.repo });

		// 1..8 in order: the local git/origin questions never touch the machine, and
		// nothing is asked of it before the local half answers.
		assert.deepEqual(client.commands(), [
			`test -d ${REMOTE_CWD}`,
			"git --version",
			`git -C ${REMOTE_CWD} rev-parse --git-dir`,
			`git -C ${REMOTE_CWD} remote get-url origin`,
			`git -C ${REMOTE_CWD} ls-remote origin`,
		]);
		assert.equal(client.execs()[4]!.timeout, 10, "D5 step 8: the remote fetch probe is bounded by 10s");
		assert.equal(client.execs()[4]!.on, HOST, "every probe names the machine it is about");

		assert.deepEqual(report, {
			host: HOST,
			cwd: REMOTE_CWD,
			at: report.at,
			ok: true,
			fetch: "ok",
		});
		assert.equal(typeof report.at, "number");
		assert.ok(report.at <= Date.now());
		// The doctor-facing record is the same run, not a copy taken earlier.
		assert.deepEqual(recorded(), report);
	} finally {
		local.cleanup();
	}
});

// ── one failure per step, in order ─────────────────────────────────────────

test("D5 step 1: a machine without git is `local-git`, and nothing remote is asked", async () => {
	resetDeliveryPreflightState();
	const bin = mkdtempSync(path.join(tmpdir(), "cross-machine-preflight-nogit-"));
	const previousPath = process.env.PATH;
	writeFileSync(path.join(bin, "git"), "#!/bin/sh\necho 'git: simulated failure' >&2\nexit 1\n", { mode: 0o755 });
	chmodSync(path.join(bin, "git"), 0o755);
	try {
		process.env.PATH = bin;
		const client = new FakePreflightClient();
		const error = await hardFailure(
			preflightDelivery({ client, target: target(), localRepo: bin }),
			"local-git",
		);
		assert.equal(
			error.message,
			"this machine has no usable git (git --version exited 1: git: simulated failure); " +
				"a cross-machine centurion delivers through git worktrees, so git must be on PATH here too. " +
				"Two ways out: 1) install git here and retry; " +
				'2) drop the worktree delivery — dispatch a worker instead: subagent({ agent: "worker", host: "vps", task: "..." }) needs no worktree and no git.',
		);
		assert.deepEqual(client.calls, [], "step 1 is local: the machine is not contacted at all");
		assert.equal(recorded().ok, false);
		assert.equal(recorded().failure?.category, "local-git");
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		rmSync(bin, { recursive: true, force: true });
	}
});

test("D5 step 2: this checkout has no origin — the D6 sentence with two ways out", async () => {
	resetDeliveryPreflightState();
	const local = localRepo();
	try {
		const client = new FakePreflightClient();
		const error = await hardFailure(
			preflightDelivery({ client, target: target(), localRepo: local.repo }),
			"local-origin",
		);
		assert.equal(
			error.message,
			`cross-machine delivery needs one shared remote: this checkout (${local.repo}) has no origin. ` +
				`Two ways out: 1) add one and retry — git -C ${local.repo} remote add origin <url> ` +
				"(the machine 'vps' must be able to reach the same url); " +
				'2) drop the worktree delivery — dispatch a worker instead: subagent({ agent: "worker", host: "vps", task: "..." }) needs no origin.',
		);
		assert.deepEqual(client.calls, [], "the local half answers before the machine is contacted");
		const report = recorded();
		assert.equal(report.ok, false);
		assert.equal(report.fetch, "skipped", "a hard failure never reaches the soft fetch step");
		assert.equal(report.failure?.code, ErrorCodes.INVALID_PARAMS);
		assert.equal(report.failure?.message, error.message);
	} finally {
		local.cleanup();
	}
});

test("D5 step 2: the three local states get three answers, and the order stops at step 2", async () => {
	// The state that produced the bad advice: `/Users/me/agents` is not a repository,
	// so `git remote add origin` (the no-origin remedy) cannot work there. Step 2 must
	// ask git TWO questions to tell the two apart, and say a third thing when git
	// itself cannot be started.
	const plainRoot = mkdtempSync(path.join(tmpdir(), "cross-machine-preflight-plain-"));
	const plain = path.join(plainRoot, "agents");
	mkdirSync(plain, { recursive: true });
	try {
		// (a) NOT a checkout at all
		resetDeliveryPreflightState();
		const notACheckoutClient = new FakePreflightClient();
		const notACheckout = await hardFailure(
			preflightDelivery({ client: notACheckoutClient, target: target(), localRepo: plain }),
			"local-origin",
		);
		assert.equal(notACheckout.message, notALocalCheckoutMessage({ host: HOST, localRepo: plain }));
		assert.doesNotMatch(notACheckout.message, /remote add/, "`git remote add` cannot work in a non-repository");
		assert.match(notACheckout.message, /needs a git checkout on this machine too/);
		// The order: step 2 answered locally, so nothing was asked of that machine.
		assert.deepEqual(notACheckoutClient.commands(), [], "no `machine.exec` at all");
		assert.deepEqual(notACheckoutClient.calls, [], "the wire stays empty for a local fact");
		assert.equal(recorded().failure?.category, "local-origin", "no new category: the local half is `local-origin`");
		assert.equal(recorded().fetch, "skipped");

		// (b) a checkout WITHOUT origin — the frozen D6 sentence, unchanged
		resetDeliveryPreflightState();
		const noOrigin = localRepo();
		try {
			const noOriginClient = new FakePreflightClient();
			const noOriginError = await hardFailure(
				preflightDelivery({ client: noOriginClient, target: target(), localRepo: noOrigin.repo }),
				"local-origin",
			);
			assert.equal(noOriginError.message, noLocalOriginMessage({ host: HOST, localRepo: noOrigin.repo }));
			assert.match(noOriginError.message, /needs one shared remote/);
			assert.match(noOriginError.message, new RegExp(`git -C ${noOrigin.repo} remote add origin <url>`));
			assert.deepEqual(noOriginClient.commands(), []);

			// (c) git that RUNS for step 1 and is gone by step 2: the missing-program
			// sentence, not "no origin". The wrapper deletes itself, which is the only
			// reachable shape of this arm (step 1 already proves `git --version`).
			resetDeliveryPreflightState();
			const bin = path.join(plainRoot, "bin");
			mkdirSync(bin, { recursive: true });
			const wrapper = path.join(bin, "git");
			writeFileSync(
				wrapper,
				// The wrapper must delete itself with an ABSOLUTE path: PATH holds only this
				// directory (so git cannot be found anywhere else), which means `rm` is not
				// resolvable by name.
				"#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  /bin/rm -f \"$0\"\n  echo 'git version 2.43.0'\n  exit 0\nfi\nexit 1\n",
				{ mode: 0o755 },
			);
			chmodSync(wrapper, 0o755);
			const previousPath = process.env.PATH;
			try {
				process.env.PATH = bin;
				const noGitClient = new FakePreflightClient();
				const noGit = await hardFailure(
					preflightDelivery({ client: noGitClient, target: target(), localRepo: noOrigin.repo }),
					"local-origin",
				);
				const state = localCheckoutState(noOrigin.repo);
				assert.equal(state.kind, "no-git");
				const noGitState = state as Extract<typeof state, { kind: "no-git" }>;
				assert.equal(
					noGit.message,
					noLocalGitMessage({ host: HOST, localRepo: noOrigin.repo, code: noGitState.code, detail: noGitState.detail }),
				);
				assert.match(noGit.message, /^this machine has no usable git \(git --version exited no exit code: /);
				assert.doesNotMatch(noGit.message, /has no origin/);
				assert.deepEqual(noGitClient.calls, []);

				// The three sentences are three, not three spellings of one.
				assert.equal(
					new Set([notACheckout.message, noOriginError.message, noGit.message]).size,
					3,
					"not-a-checkout / no-origin / no-git must not collapse",
				);
			} finally {
				if (previousPath === undefined) delete process.env.PATH;
				else process.env.PATH = previousPath;
			}
		} finally {
			noOrigin.cleanup();
		}
	} finally {
		rmSync(plainRoot, { recursive: true, force: true });
	}
});

test("D5 step 3: a missing checkout there stops the order after `test -d`", async () => {
	resetDeliveryPreflightState();
	const local = localRepo("git@example.com:acme/pi-legion.git");
	try {
		const client = new FakePreflightClient().onArgv("test -d", () => execResult({ code: 1 }));
		const error = await hardFailure(
			preflightDelivery({ client, target: target(), localRepo: local.repo }),
			"remote-checkout",
		);
		assert.equal(
			error.message,
			`host 'vps' has no checkout at ${REMOTE_CWD} (the configured cwd does not exist on that machine). ` +
				`Two ways out: 1) give that machine a checkout at ${REMOTE_CWD} — git clone <url> ${REMOTE_CWD} on 'vps' — ` +
				"or point subagents.crossMachine.hosts.vps.cwd at a directory that is a git checkout; " +
				"2) dispatch a worker instead (workers need no worktree and no git).",
		);
		assert.deepEqual(client.commands(), [`test -d ${REMOTE_CWD}`], "git is not asked about a path that is not there");
	} finally {
		local.cleanup();
	}
});

test("D5 step 4: git missing on that machine is `remote-git`, not a missing checkout", async () => {
	resetDeliveryPreflightState();
	const local = localRepo("git@example.com:acme/pi-legion.git");
	try {
		const client = healthyClient().override("git --version", () =>
			execResult({ code: 127, stderr: base64("sh: 1: git: not found") }),
		);
		const error = await hardFailure(preflightDelivery({ client, target: target(), localRepo: local.repo }), "remote-git");
		assert.equal(
			error.message,
			"host 'vps': git is not available on that machine (git --version exited 127: sh: 1: git: not found). " +
				"A cross-machine centurion delivers through git worktrees, so git must be on PATH there. " +
				"Two ways out: 1) install git on 'vps' and retry; 2) dispatch a worker instead (workers need no worktree and no git).",
		);
		// The checkout question was answered first, and `rev-parse` is never asked:
		// without git its answer would be another phrasing of the same missing program.
		assert.deepEqual(client.commands(), [`test -d ${REMOTE_CWD}`, "git --version"]);
	} finally {
		local.cleanup();
	}
});

test("D5 step 5: a directory that is not a repository is `remote-checkout`", async () => {
	resetDeliveryPreflightState();
	const local = localRepo("git@example.com:acme/pi-legion.git");
	try {
		const client = healthyClient().override("rev-parse --git-dir", () =>
			execResult({ code: 128, stderr: base64("fatal: not a git repository (or any of the parent directories): .git") }),
		);
		const error = await hardFailure(
			preflightDelivery({ client, target: target(), localRepo: local.repo }),
			"remote-checkout",
		);
		assert.equal(
			error.message,
			`host 'vps': ${REMOTE_CWD} is not a git repository on that machine. ` +
				`Two ways out: 1) give that machine a checkout at ${REMOTE_CWD} — git clone <url> ${REMOTE_CWD} on 'vps' — ` +
				"or point subagents.crossMachine.hosts.vps.cwd at a directory that is a git checkout; " +
				"2) dispatch a worker instead (workers need no worktree and no git).",
		);
		assert.deepEqual(client.commands().slice(-1), [`git -C ${REMOTE_CWD} rev-parse --git-dir`]);
		assert.equal(client.commands().some((command) => command.includes("remote get-url")), false);
	} finally {
		local.cleanup();
	}
});

test("D5 step 5: `rev-parse` exiting 127 is `remote-git`, and the sentence names the command that RAN", async () => {
	resetDeliveryPreflightState();
	const local = localRepo("git@example.com:acme/pi-legion.git");
	try {
		const client = healthyClient().override("rev-parse --git-dir", () =>
			execResult({ code: 127, stderr: base64("sh: 1: git: not found") }),
		);
		const error = await hardFailure(preflightDelivery({ client, target: target(), localRepo: local.repo }), "remote-git");
		// Review m1: the frozen D6 sentence used to end "(git --version exited 127: …)"
		// even though this step runs `git -C <cwd> rev-parse --git-dir` — the operator was
		// sent to test a command that had succeeded two steps earlier.
		assert.equal(
			error.message,
			`host 'vps': git is not available on that machine (git -C ${REMOTE_CWD} rev-parse --git-dir exited 127: sh: 1: git: not found). ` +
				"A cross-machine centurion delivers through git worktrees, so git must be on PATH there. " +
				"Two ways out: 1) install git on 'vps' and retry; 2) dispatch a worker instead (workers need no worktree and no git).",
		);
	} finally {
		local.cleanup();
	}
});

test("D5 step 6: that checkout has no origin — the D6 sentence naming the local url", async () => {
	resetDeliveryPreflightState();
	const local = localRepo("git@example.com:acme/pi-legion.git");
	try {
		const client = healthyClient().override("remote get-url origin", () =>
			execResult({ code: 2, stderr: base64("error: No such remote 'origin'") }),
		);
		const error = await hardFailure(
			preflightDelivery({ client, target: target(), localRepo: local.repo }),
			"remote-origin",
		);
		assert.equal(
			error.message,
			`host 'vps': ${REMOTE_CWD} has no origin on that machine; cross-machine delivery needs one shared remote. ` +
				`Two ways out: 1) add one there — hc exec --on vps -- git -C ${REMOTE_CWD} remote add origin <url> ` +
				"(same url as this checkout's 'git@example.com:acme/pi-legion.git'); " +
				"2) dispatch a worker instead (workers need no origin).",
		);
	} finally {
		local.cleanup();
	}
});

test("D5 step 7: two different origins — the D6 sentence names BOTH urls", async () => {
	resetDeliveryPreflightState();
	const local = localRepo("git@example.com:acme/pi-legion.git");
	try {
		const client = healthyClient("git@example.com:acme/fork.git");
		const error = await hardFailure(
			preflightDelivery({ client, target: target(), localRepo: local.repo }),
			"origin-mismatch",
		);
		assert.equal(
			error.message,
			`host 'vps': its checkout at ${REMOTE_CWD} has origin 'git@example.com:acme/fork.git' but this checkout's is ` +
				"'git@example.com:acme/pi-legion.git'; cross-machine delivery needs one shared remote. " +
				"Two ways out: 1) make both sides point at one url (git remote set-url origin <url> on either side); " +
				"2) dispatch a worker instead (workers need no origin).",
		);
		assert.equal(
			client.commands().some((command) => command.includes("ls-remote")),
			false,
			"an unreachable fetch is not asked about after the identities already disagree",
		);
	} finally {
		local.cleanup();
	}
});

// ── the soft step ──────────────────────────────────────────────────────────

test("D5 step 8: an unreachable origin is RECORDED, never thrown", async () => {
	resetDeliveryPreflightState();
	const local = localRepo("git@example.com:acme/pi-legion.git");
	try {
		const client = healthyClient().override("ls-remote origin", () =>
			execResult({ code: 128, stderr: base64("fatal: could not read Username for 'https://github.com': terminal prompts disabled") }),
		);
		const report = await preflightDelivery({ client, target: target(), localRepo: local.repo });
		assert.equal(report.ok, true, "a fetch refusal is not a reason to refuse the launch");
		assert.equal(report.fetch, "unreachable");
		assert.match(
			String(report.fetchDetail),
			/could not read Username for 'https:\/\/github.com': terminal prompts disabled/,
			"git's own words must survive into the report doctor shows",
		);
		assert.deepEqual(recorded(), report);
	} finally {
		local.cleanup();
	}
});

test("D5 step 8: a `timed_out` probe is the SOFT outcome — `fetch: unreachable`, and the original words are kept", async () => {
	resetDeliveryPreflightState();
	const local = localRepo("git@example.com:acme/pi-legion.git");
	try {
		// Review M2: `remoteExec` throws for `timed_out: true`, and the catch used to map
		// that throw to a hard `transport` refusal — contradicting this file's own rule
		// that a slow network is recorded, never thrown. The machine ANSWERED; it was
		// merely slower than the probe's 10s budget.
		const client = healthyClient().override("ls-remote origin", () =>
			execResult({ code: 0, timed_out: true, stdout: base64("partial") }),
		);
		const report = await preflightDelivery({ client, target: target(), localRepo: local.repo });
		assert.equal(report.ok, true, "a slow remote is not a reason to refuse the launch");
		assert.equal(report.fetch, "unreachable");
		assert.match(String(report.fetchDetail), /timed_out/, "the detail keeps remoteExec's own words");
		assert.match(String(report.fetchDetail), /ls-remote origin did not finish within 10s/);
		assert.equal(report.failure, undefined, "nothing failed: the order completed");
		assert.deepEqual(recorded(), report);
	} finally {
		local.cleanup();
	}
});

test("D5 step 8: a machine that does not answer AT ALL — `machine_unknown` — is still a hard `transport`", async () => {
	resetDeliveryPreflightState();
	const local = localRepo("git@example.com:acme/pi-legion.git");
	try {
		// The other half of M2: the soft turn is for a slow machine, not for a machine
		// that does not exist. A wrong host name is a fact about the configuration, so it
		// must stay hard (and must not walk the model fallback chain).
		const client = healthyClient().override("ls-remote origin", () => {
			throw new HcRpcError({ code: -32000, message: "unknown machine: vps", data: { kind: "machine_unknown" } });
		});
		const error = await hardFailure(preflightDelivery({ client, target: target(), localRepo: local.repo }), "transport");
		assert.match(error.message, /machine_unknown: unknown machine: vps/, "the core's own kind and words are kept");
		const report = recorded();
		assert.equal(report.ok, false);
		assert.equal(report.fetch, "skipped", "an unanswered probe has no fetch verdict to report");
		assert.equal(report.failure?.category, "transport");
	} finally {
		local.cleanup();
	}
});

test("D5 step 8: a transport failure inside the soft step is still a hard `transport`", async () => {
	resetDeliveryPreflightState();
	const local = localRepo("git@example.com:acme/pi-legion.git");
	try {
		const thrown = new HcRpcError({ code: -32000, message: "socket closed", data: { kind: "timeout" } });
		const client = healthyClient().override("ls-remote origin", () => {
			throw thrown;
		});
		const error = await hardFailure(
			preflightDelivery({ client, target: target(), localRepo: local.repo }),
			"transport",
		);
		assert.match(error.message, /^host 'vps': the delivery preflight could not talk to that machine/);
		assert.match(error.message, /timeout: socket closed/, "the core's own kind and words are kept");
		const report = recorded();
		assert.equal(report.ok, false);
		assert.equal(report.failure?.category, "transport");
	} finally {
		local.cleanup();
	}
});

test("D5 step 3: a transport failure at the first remote question is `transport`, not a missing checkout", async () => {
	resetDeliveryPreflightState();
	const local = localRepo("git@example.com:acme/pi-legion.git");
	try {
		const client = new FakePreflightClient().onArgv("test -d", () => {
			throw new HcRpcError({ code: -32000, message: "unknown machine: vps", data: { kind: "machine_unknown" } });
		});
		const error = await hardFailure(
			preflightDelivery({ client, target: target(), localRepo: local.repo }),
			"transport",
		);
		assert.match(error.message, /machine_unknown: unknown machine: vps/);
	} finally {
		local.cleanup();
	}
});

// ── the record doctor reads ────────────────────────────────────────────────

test("D5: `lastDeliveryPreflight()` answers never / ok / failed, and the reset clears it", async () => {
	resetDeliveryPreflightState();
	assert.equal(lastDeliveryPreflight(), undefined, "before any run the answer is `never`");

	const local = localRepo("git@example.com:acme/pi-legion.git");
	try {
		// ok
		await preflightDelivery({ client: healthyClient(), target: target(), localRepo: local.repo });
		const ok = recorded();
		assert.equal(ok.ok, true);
		assert.equal(ok.fetch, "ok");
		assert.equal(ok.host, HOST);
		assert.equal(ok.cwd, REMOTE_CWD);
		assert.equal(ok.failure, undefined);

		// failed — replacing the previous answer, because the last attempt is the one
		// an operator reading doctor needs to see.
		await preflightDelivery({
			client: new FakePreflightClient().onArgv("test -d", () => execResult({ code: 1 })),
			target: target(),
			localRepo: local.repo,
		}).catch(() => undefined);
		const failed = recorded();
		assert.equal(failed.ok, false);
		assert.equal(failed.fetch, "skipped");
		assert.equal(failed.failure?.category, "remote-checkout");
		assert.ok(failed.at >= ok.at, "the stamp moves forward");

		resetDeliveryPreflightState();
		assert.equal(lastDeliveryPreflight(), undefined, "the test seam really clears the holder's field");
	} finally {
		local.cleanup();
	}
});
