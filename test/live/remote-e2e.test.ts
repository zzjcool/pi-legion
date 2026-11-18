/**
 * S5 — cross-machine end-to-end against a REAL ssh machine (contract
 * `cross-machine-spawn-v1` §S5; runbook `docs/runbooks/cross-machine-live-e2e.md`).
 *
 * Nothing here is faked. Every other cross-machine test in this repository drives
 * `test/helpers/fake-hc-core.mjs`, which is deliberately stricter than the real
 * core but is still one process on one machine: it cannot prove that `hc` really
 * ships `on`, that a remote shell starts in the right directory, or that a push
 * from that machine is visible here. This file is the only place those are asked
 * of a real one.
 *
 * It is therefore GATED, and the gate is the safety mechanism, not a convenience:
 *
 *   PI_LEGION_REMOTE_HOST   required. The `hc` machine name (from `hc machine ls`).
 *   PI_LEGION_REMOTE_CWD    required. Absolute path of THIS repository ON THAT
 *                           machine (a checkout of the same commit, same origin).
 *   HC_SESSION              must start with `test-`. The suite creates and kills
 *                           terminals; it must never do that inside a real session's
 *                           namespace.
 *   PI_LEGION_REMOTE_ORIGIN optional. Absolute path on THAT machine of a bare repo
 *                           both sides can push/fetch (same repository). Present ⇒
 *                           the delivery loop runs; absent ⇒ it skips.
 *   PI_LEGION_REMOTE_FULL   optional. `1` ⇒ also spawn a REAL `pi` child there.
 *                           That needs a working model credential on that machine
 *                           and costs a real turn; it is opt-in.
 *   PI_LEGION_REMOTE_NODE / PI_LEGION_REMOTE_PI
 *                           optional. Programs to use on that machine
 *                           (default `node` / `pi`). A non-interactive remote
 *                           shell usually has NO nvm/PATH setup, so give absolute
 *                           paths (`/root/.nvm/versions/node/…/node`,
 *                           `/root/.pi/agent/bin/pi`) or the preflight says
 *                           `node 'node' is not on PATH on <host>` in ten seconds.
 *   PI_LEGION_REMOTE_PI_EXTENSIONS
 *                           optional. Comma-separated extensions the child must LOAD
 *                           on that machine (whitespace around entries is ignored).
 *                           Needed whenever the host's MODELS come from an extension:
 *                           a child argv carries `--no-extensions`, which on such a
 *                           machine also removes the provider, and the launch-time
 *                           probe refuses with `No models available` until the
 *                           provider is named here. Unset ⇒ the key is not sent at
 *                           all (a host with builtin models needs nothing).
 *   PI_LEGION_REMOTE_PI_LEGION_ROOT
 *                           optional. Where THIS package lives on that machine.
 *                           The two checkouts are almost never at the same path
 *                           (parent Mac `/Users/…/code/pi-legion`, target
 *                           `/root/code/pi-legion`), and every child's argv loads
 *                           `<root>/index.ts` over there. Unset ⇒ the parent path
 *                           is used and the preflight refuses with exit 14 — which
 *                           is the right answer, not a bug.
 *
 * Missing gate ⇒ `test.skip` with the reason, so `npm run test:live` is a no-op on
 * a machine that has no remote configured instead of a false red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { hcCliClient, type HcClient } from "../../src/hc/client.ts";
import {
	normalizeHost,
	remotePreflight,
	resolveHostTarget,
	type HostTarget,
} from "../../src/runs/remote.ts";
import {
	assertRemoteResume,
	readRemoteText,
} from "../../src/runs/remote-artifact.ts";
import { remoteVerifyCommand } from "../../src/runs/remote-verify.ts";
import type { SpawnInput } from "../../src/supervisor/types.ts";
import {
	createRemoteChildWorktree,
	fetchRemoteBranch,
	remoteBranchTipOnOrigin,
	removeRemoteChildWorktree,
} from "../../src/runs/remote-worktree.ts";

const HOST = (process.env.PI_LEGION_REMOTE_HOST ?? "").trim();
const CWD = (process.env.PI_LEGION_REMOTE_CWD ?? "").trim();
const ORIGIN = (process.env.PI_LEGION_REMOTE_ORIGIN ?? "").trim();
const NODE = (process.env.PI_LEGION_REMOTE_NODE ?? "node").trim() || "node";
const PI = (process.env.PI_LEGION_REMOTE_PI ?? "pi").trim() || "pi";
const PI_LEGION_ROOT = (process.env.PI_LEGION_REMOTE_PI_LEGION_ROOT ?? "").trim();
/**
 * `PI_LEGION_REMOTE_PI_EXTENSIONS` → the host's `piExtensions`.
 *
 * Comma-separated, whitespace-tolerant: an operator pasting two paths should not have
 * to think about spacing. An empty/blank value means "not given" — the key is then
 * omitted from the host entry, which is exactly today's behaviour.
 */
const PI_EXTENSIONS = (process.env.PI_LEGION_REMOTE_PI_EXTENSIONS ?? "")
	.split(",")
	.map((entry) => entry.trim())
	.filter((entry) => entry.length > 0);
const FULL = process.env.PI_LEGION_REMOTE_FULL === "1";
const SESSION = process.env.HC_SESSION ?? "";

/**
 * Why this file cannot run here — or `undefined` when the gate is open.
 *
 * The `HC_SESSION` rule is the one that matters: this suite runs `terminal.kill`
 * and `worktree remove` on another machine, and a real session's namespace is not
 * a place to experiment.
 */
function gateSkipReason(needs: { origin?: boolean; full?: boolean } = {}): string | undefined {
	if (HOST.length === 0) return "PI_LEGION_REMOTE_HOST is not set (see docs/runbooks/cross-machine-live-e2e.md)";
	if (CWD.length === 0) return "PI_LEGION_REMOTE_CWD is not set (absolute path of the repo on that machine)";
	if (!SESSION.startsWith("test-")) {
		return `HC_SESSION must start with 'test-' for the live cross-machine suite (got '${SESSION || "<unset>"}') — it creates and kills terminals on another machine`;
	}
	if (needs.origin === true && ORIGIN.length === 0) {
		return "PI_LEGION_REMOTE_ORIGIN is not set (absolute path of a bare repo both sides can reach)";
	}
	if (needs.full === true && !FULL) {
		return "PI_LEGION_REMOTE_FULL is not set to 1 (spawns a real `pi` child on that machine)";
	}
	// Deliberately NOT gated on PI_LEGION_REMOTE_PI_EXTENSIONS. Whether that machine's
	// models come from an extension is a property of ITS configuration, which this
	// suite cannot know: a host with builtin models needs nothing here, and skipping
	// "just in case" would turn "the operator forgot one env var" into "the test
	// silently did not run". The launch-time probe already fails in ten seconds and
	// names the key, which is the signal worth having.
	return undefined;
}

/** This machine's checkout: discovered from the module's own location. */
const LOCAL_REPO = execFileSync("git", ["-C", path.resolve(import.meta.dirname), "rev-parse", "--show-toplevel"], {
	encoding: "utf8",
}).trim();

function target(): HostTarget {
	const resolved = resolveHostTarget(HOST, {
		enabled: true,
		hosts: {
			[HOST]: {
				cwd: CWD,
				node: NODE,
				piCli: PI,
				// Only when the operator says where the package lives over there. Unset
				// keeps today's behaviour (the parent's path, refused by the preflight):
				// guessing another checkout's layout would be exactly the silent
				// wrong-path launch M2 exists to prevent.
				...(PI_LEGION_ROOT ? { piLegionRoot: PI_LEGION_ROOT } : {}),
				// Only when named: an absent key keeps the argv byte-identical to a host
				// that needs no extensions.
				...(PI_EXTENSIONS.length > 0 ? { piExtensions: PI_EXTENSIONS } : {}),
			},
		},
	});
	return resolved;
}

/** One client for a test, closed afterwards; the transport is the real socket. */
function withClient(body: (client: HcClient) => Promise<void>): Promise<void> {
	const client = hcCliClient({ env: process.env });
	return (async () => {
		await client.start();
		try {
			await body(client);
		} finally {
			client.close();
		}
	})();
}

/** `machine.exec` with the same 10s bound the product uses for preflight questions. */
async function exec(client: HcClient, argv: string[], cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const result = await client.request<{ code?: number | null; stdout?: string; stderr?: string; timed_out?: boolean }>(
		"machine.exec",
		{ on: HOST, argv, timeout: 10, ...(cwd ? { cwd } : {}) },
	);
	const decode = (value: string | undefined): string => (value ? Buffer.from(value, "base64").toString("utf8") : "");
	return { code: typeof result?.code === "number" ? result.code : null, stdout: decode(result?.stdout), stderr: decode(result?.stderr) };
}

// ── S5.1 — the three questions a launch asks before it touches anything ──────

test("S5.1 preflight: that machine answers, the checkout is a git repo, and both sides share one origin", async (t) => {
	const skip = gateSkipReason();
	if (skip) return t.skip(skip);
	await withClient(async (client) => {
		const started = Date.now();
		// `remotePreflight` is the product's own gate: cwd exists, `node`/`pi` resolve,
		// this package's entry is installed, and the core does not carry legion identity.
		await remotePreflight(client, target());
		const elapsed = Date.now() - started;
		// The product bounds this at 10s on purpose: an unusable remote must fail with a
		// name in ten seconds, not surface later as a mysterious verify timeout.
		assert.ok(elapsed < 15_000, `preflight must be bounded (took ${elapsed}ms)`);

		// The checkout is a git work tree at the same commit-ish as this one.
		const inside = await exec(client, ["git", "rev-parse", "--is-inside-work-tree"], CWD);
		assert.equal(inside.code, 0, `not a git checkout on that machine: ${inside.stderr}`);
		assert.equal(inside.stdout.trim(), "true");
		const head = await exec(client, ["git", "rev-parse", "HEAD"], CWD);
		assert.equal(head.code, 0, `cannot read HEAD there: ${head.stderr}`);
		assert.match(head.stdout.trim(), /^[0-9a-f]{40}$/, "HEAD must be a real commit id");

		// One shared remote: the same URL on both sides. This is what makes a push from
		// there visible here, and `resolveHostTarget` refuses a launch without it.
		const originThere = await exec(client, ["git", "remote", "get-url", "origin"], CWD);
		const originHere = execFileSync("git", ["-C", LOCAL_REPO, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
		assert.equal(originThere.code, 0, `that checkout has no origin: ${originThere.stderr}`);
		assert.equal(
			originThere.stdout.trim(),
			originHere,
			`the two checkouts must share one origin (there: ${originThere.stdout.trim()}, here: ${originHere})`,
		);
	});
});

// ── S5.2 — the four-step resume gate against the real machine ────────────────

test("S5.2 resume gate: an unknown terminal fails at step 3 with its address", async (t) => {
	const skip = gateSkipReason();
	if (skip) return t.skip(skip);
	// Steps 1, 2 and 4 are asked of the real machine; step 3 is forced to fail by
	// naming a terminal nobody created. The message must match the product's wording,
	// because that wording is the operator's map of what went wrong.
	await assert.rejects(
		() => assertRemoteResume({
			crossMachine: { enabled: true, hosts: { [HOST]: { cwd: CWD, node: NODE, piCli: PI } } },
			request: { host: HOST, name: "s5-probe", terminalName: "lgl-s5-no-such-terminal" },
		}),
		(error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			assert.match(message, /\(step 3\/4\)/, message);
			assert.match(message, new RegExp(`${HOST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/lgl-s5-no-such-terminal`), message);
			return true;
		},
	);
	// And the machine-level facts of the same gate are true, so the failure above is
	// genuinely about the terminal and not about reachability.
	await withClient(async (client) => {
		const reachable = await exec(client, ["true"]);
		assert.equal(reachable.code, 0, "the machine must answer `true`");
		const tree = await exec(client, ["test", "-d", CWD]);
		assert.equal(tree.code, 0, "the checkout must exist there");
	});
});

// ── S5.3 — remote verify: a real command on that machine ─────────────────────

test("S5.3 verify: `true` passes and `false` is a code failure, both naming the machine", async (t) => {
	const skip = gateSkipReason();
	if (skip) return t.skip(skip);
	await withClient(async (client) => {
		const host = target();
		const pass = await remoteVerifyCommand({ client, target: host, command: "true", timeoutMs: 30_000 });
		assert.equal(pass.code, 0, JSON.stringify(pass));
		assert.equal(pass.failure, undefined);
		assert.equal(pass.host, HOST);

		const fail = await remoteVerifyCommand({ client, target: host, command: "false", timeoutMs: 30_000 });
		assert.equal(fail.failure, "code");
		assert.equal(fail.code, 1);
		assert.equal(fail.host, HOST);

		// A timeout is the third class and must NOT look like a code failure. One second
		// is enough: the core kills the command at the deadline (spike fact 3).
		const slow = await remoteVerifyCommand({ client, target: host, command: "sleep 30", timeoutMs: 1_000 });
		assert.equal(slow.failure, "timeout", JSON.stringify(slow));
	});
});

// ── S5.4 — read-back: exact line counts from a real file ──────────────────────

test("S5.4 read-back: a file written there comes back with its exact line count", async (t) => {
	const skip = gateSkipReason();
	if (skip) return t.skip(skip);
	await withClient(async (client) => {
		const probe = path.posix.join(CWD, `.s5-readback-${process.pid}.txt`);
		try {
			// 5 lines, written ON that machine, read back through `hc file.read`.
			const written = await client.request("machine.exec", {
				on: HOST,
				line: `printf 'one\\ntwo\\nthree\\nfour\\nfive\\n' > '${probe}'`,
				cwd: CWD,
				timeout: 10,
			});
			assert.equal((written as { code?: number }).code, 0);
			const read = await readRemoteText({ client, target: target(), remotePath: probe, tailLines: 100 });
			assert.equal(read.lines, 5, "`lines` is the FILE's total line count");
			assert.equal(read.returned, 5);
			assert.equal(read.truncated, false);
			assert.match(read.text, /five/);

			// A tail window is a tail: the last line is in, the first one is not.
			const tail = await readRemoteText({ client, target: target(), remotePath: probe, tailLines: 2 });
			assert.equal(tail.lines, 5);
			assert.equal(tail.returned, 2);
			assert.equal(tail.truncated, true);
			assert.match(tail.text, /five/);
			assert.doesNotMatch(tail.text, /^one$/m);
		} finally {
			await client.request("machine.exec", { on: HOST, argv: ["rm", "-f", probe], timeout: 10 }).catch(() => undefined);
		}
	});
});

// ── S5.5 — the delivery loop: worktree there, push there, fetch here ─────────

test("S5.5 delivery: a remote worktree commits and pushes, and this machine fetches the same sha", async (t) => {
	const skip = gateSkipReason({ origin: true });
	if (skip) return t.skip(skip);
	const name = `s5-delivery-${process.pid}`;
	const parentDir = mkdtempSync(path.join(tmpdir(), "s5-live-"));
	const parentRepo = path.join(parentDir, "repo");
	execFileSync("git", ["clone", "-q", ORIGIN, parentRepo]);
	let created: { path: string; branch: string } | undefined;
	try {
		await withClient(async (client) => {
			created = await createRemoteChildWorktree({
				client,
				target: target(),
				name,
				// The parent side must be a checkout of the SAME repository; the cloned
				// `parentRepo` is exactly that, and it keeps this test from touching the
				// working checkout the suite runs in.
				localRepo: parentRepo,
			});
			assert.match(created.branch, new RegExp(`^pi-subagent/${HOST.replace(/[^A-Za-z0-9._-]/g, "-")}/${name}-[0-9a-f]{8}$`));
			assert.ok(path.posix.isAbsolute(created.path));

			// The tree exists THERE and starts on the branch.
			const status = await exec(client, ["git", "rev-parse", "--abbrev-ref", "HEAD"], created.path);
			assert.equal(status.stdout.trim(), created.branch, `the tree must be on its branch (stderr: ${status.stderr})`);

			// A commit made THERE, pushed THERE — the only delivery channel there is.
			const commit = await client.request("machine.exec", {
				on: HOST,
				line: `cd '${created.path}' && printf 'delivered by ${HOST}\\n' > S5-DELIVERY.md && git add S5-DELIVERY.md && git -c user.name=s5 -c user.email=s5@example.com commit -q -m 's5 delivery' && git rev-parse HEAD`,
				timeout: 60,
			});
			assert.equal((commit as { code?: number }).code, 0, JSON.stringify(commit));
			const pushed = await client.request("machine.exec", {
				on: HOST,
				line: `cd '${created.path}' && git push -q -u origin '${created.branch}' && git rev-parse HEAD`,
				timeout: 120,
			});
			assert.equal((pushed as { code?: number }).code, 0, JSON.stringify(pushed));
			const tipThere = Buffer.from(String((pushed as { stdout?: string }).stdout ?? ""), "base64").toString("utf8").trim();
			assert.match(tipThere, /^[0-9a-f]{40}$/);
		});

		assert.ok(created, "the worktree must have been created");
		// Back on this machine: the branch is fetchable and points at the same commit.
		const fetched = await fetchRemoteBranch({ localRepo: parentRepo, branch: created.branch });
		assert.equal(fetched.sha, remoteBranchTipOnOrigin(parentRepo, created.branch));
	} finally {
		if (created) {
			await withClient(async (client) => {
				await removeRemoteChildWorktree({ client, target: target(), path: created!.path }).catch(() => undefined);
				// The branch is deliberately left on the origin: deleting it would hide
				// whether delivery really happened. The runbook says how to clean up.
			}).catch(() => undefined);
		}
		rmSync(parentDir, { recursive: true, force: true });
	}
});

// ── S5.6 — a real `pi` child there (opt-in: needs a credential on that machine) ─

test("S5.6 full child: a real pi process runs on that machine, in the tree the parent gave it", async (t) => {
	const skip = gateSkipReason({ full: true });
	if (skip) return t.skip(skip);
	// The one test that needs the remote `pi` installed, configured and able to reach
	// a model. Everything it asserts is about the plumbing, not the answer.
	//
	// LAYERING (this is what the first real run taught): the terminal backend does not
	// decide where a cross-machine child works. `createRemoteChildWorktree` is the
	// orchestrator's step; the backend REUSES a tree it is handed (`worktreePath`) and
	// only creates one when asked to (`createWorktree`). So this test does both steps
	// in the order production does, instead of asserting that the backend invented a
	// tree it was never asked for.
	const { TerminalSupervisor } = await import("../../src/supervisor/terminal-supervisor.ts");
	const { createRemoteSessionReadback } = await import("../../src/runs/remote-artifact.ts");
	// `diff` a real checkout the remote tree's `origin` can be compared against; the
	// suite's own checkout is that checkout, and `createRemoteChildWorktree` refuses
	// to build a tree when the two sides do not share one origin.
	const root = mkdtempSync(path.join(tmpdir(), "s5-child-"));
	const name = `s5-child-${process.pid}`;
	const sessionFile = path.join(root, "placeholder.jsonl");
	const tempDir = path.join(root, "temp");
	fs.mkdirSync(tempDir, { recursive: true });
	const runDir = path.join(root, "run");

	// One client for the tree step, a second (inside the supervisor) for the spawn:
	// both are closed below, and the supervisor is closed even when an assertion
	// fails — an `hc` connection that outlives the test keeps the whole node process
	// alive, so "the test finished" must mean "the process can exit".
	let treeClient: HcClient | undefined;
	let supervisorClient: HcClient | undefined;
	let tree: { path: string; branch: string } | undefined;
	const supervisor = new TerminalSupervisor({
		runId: "test-s5",
		env: process.env,
		pollIntervalMs: 250,
		// `remote-child-fate-v1` §4: the live harness asserts the LAUNCH, not the
		// start-up gate; keeping the gate off keeps this case's timing as it was.
		remoteStartupConfirmMs: 0,
		clientFactory: () => {
			supervisorClient = hcCliClient({ env: process.env });
			return supervisorClient;
		},
	});
	t.after(async () => {
		await supervisor.retire(name).catch(() => undefined);
		if (tree) {
			try {
				treeClient = treeClient ?? hcCliClient({ env: process.env });
				await treeClient.start();
				await removeRemoteChildWorktree({ client: treeClient, target: target(), path: tree.path });
			} catch {
				/* the runbook says how to clean a tree by hand */
			}
		}
		supervisorClient?.close();
		treeClient?.close();
		rmSync(root, { recursive: true, force: true });
	});

	try {
		// Step 1 — the tree (production: orchestrator, before the spawn).
		treeClient = hcCliClient({ env: process.env });
		await treeClient.start();
		tree = await createRemoteChildWorktree({ client: treeClient, target: target(), name, localRepo: LOCAL_REPO });
		assert.match(tree.branch, new RegExp(`^pi-subagent/${HOST.replace(/[^A-Za-z0-9._-]/g, "-")}/${name}-[0-9a-f]{8}$`));

		// Step 2 — the child, told to work IN that tree.
		const handle = await supervisor.spawnChild({
			name,
			sessionFile,
			tempDir,
			cwd: LOCAL_REPO,
			host: HOST,
			hostTarget: target(),
			worktree: true,
			worktreePath: tree.path,
			worktreeBranch: tree.branch,
			agent: {
				name: "worker",
				kind: "pi",
				inheritExtensions: false,
				inheritSkills: false,
				inheritProjectContext: false,
			} as unknown as SpawnInput["agent"],
			task: "Write the single word ready into S5-READY.txt in your working directory, then stop.",
		});
		// The handle reports the trio it was GIVEN (and the ownership pair is one value,
		// D13): a provided tree is reused, not rebuilt.
		assert.equal(normalizeHost(handle.worktreeHost), HOST);
		assert.equal(handle.worktreePath, tree.path, "the child must be started in the tree it was handed");
		assert.equal(handle.worktreeBranch, tree.branch);
		assert.ok(handle.remoteDir, "the mirror dir must come back on the handle (m6)");

		// The transcript is written THERE, and read back to here.
		const localPath = path.join(runDir, "remote", `${name}.jsonl`);
		const readback = createRemoteSessionReadback({
			crossMachine: { enabled: true, hosts: { [HOST]: { cwd: CWD, node: NODE, piCli: PI } } },
		});
		const deadline = Date.now() + 5 * 60_000;
		let read: Awaited<ReturnType<typeof readback>> | undefined;
		while (Date.now() < deadline) {
			read = await readback({ host: HOST, name, localPath, ...(handle.remoteDir ? { remoteDir: handle.remoteDir } : {}) });
			if (read.ok && read.lines > 0) break;
			await new Promise((resolve) => setTimeout(resolve, 2_000));
		}
		assert.ok(read?.ok === true, `the transcript must be readable: ${JSON.stringify(read)}`);
		if (read?.ok !== true) return;
		assert.ok(read.lines > 0, "a started child writes its session header immediately");
		assert.equal(read.localPath, localPath);
		// And the transcript says it is working in the tree, not in the bare checkout:
		// this is the fact the layering above exists to guarantee.
		const mirrored = fs.readFileSync(read.localPath, "utf8");
		assert.match(
			mirrored,
			new RegExp(tree.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			`the session header must name the tree as its cwd: ${mirrored.slice(0, 400)}`,
		);
	} finally {
		// Belt and braces: `t.after` also runs on failure, but a failing assertion can
		// throw BEFORE `t.after` is registered by an inner helper — closing here makes
		// "no leaked hc connection" true on every path out of this test.
		await supervisor.retire(name).catch(() => undefined);
	}
});
