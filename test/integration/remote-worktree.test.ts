/**
 * Cross-machine worktree + git-remote delivery — S2, end to end through the REAL
 * `HcCliClient`, the REAL `TerminalSupervisor` and the fake `hc` core
 * (`test/helpers/fake-hc-core.mjs`, the oracle).
 *
 * The fixture is three real repositories under one `tmp` dir:
 *
 *   origin.git      a bare repository: the ONE shared remote (contract D10)
 *   work-parent/    this machine's checkout (what the orchestrator passes as `cwd`)
 *   remote/         what stands for the other machine's filesystem
 *     work-remote/  its checkout (the configured `cwd`)
 *     .pi-worktrees/<name>   the tree `git worktree add -b` creates there
 *
 * `FAKE_HC_REMOTE_ROOT` is `remote/`, so the fake core enforces "that path is on
 * that machine" for every `machine.exec`/`file.write`/`terminal.run` — a remote
 * path that leaked from the parent, or a parent path sent as a remote one, fails
 * HARD there instead of quietly passing a shape assertion.
 *
 * What is proven here and nowhere else:
 *   - the tree is created by the BACKEND, on the other machine, with a branch
 *     under `pi-subagent/<host>/…` (D11/D12);
 *   - `terminal.run` starts inside that tree, and carries no `caller`
 *     (constraint 5);
 *   - the delivery channel closes: a commit in the remote tree, pushed to the
 *     shared `origin`, is fetched by the parent (`fetchRemoteBranch`, D10);
 *   - the three pre-spawn refusals name the failing fact LITERALLY and never
 *     create a terminal.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { HcCliClient, type HcClient, type HcMethod } from "../../src/hc/client.ts";
import { resolveHostTarget, type HostTarget } from "../../src/runs/remote.ts";
import {
	fetchRemoteBranch,
	notALocalCheckoutMessage,
	remoteBranchTipOnOrigin,
	remoteWorktreePathFor,
} from "../../src/runs/remote-worktree.ts";
import { TerminalSupervisor } from "../../src/supervisor/terminal-supervisor.ts";
import { ErrorCodes, SubagentError, type AgentConfig } from "../../src/shared/types.ts";
import type { SpawnInput } from "../../src/supervisor/types.ts";

// ── fixtures ───────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const FAKE_CORE = path.join(REPO_ROOT, "test/helpers/fake-hc-core.mjs");
// Hermetic: discovery on the host walks whatever machine runs the suite, and a
// remote launch refuses an argv path it cannot map (S1's lesson).
process.env.PI_LEGION_CHILD_INHERIT_EXTENSIONS = "0";

const HOST = "fakebox";
const TERMINAL_ID = "t1k";
const SOCKET = "/tmp/hc-fake/default.sock";
const CHILD_NAME = "centos-1";

const GIT_ID = ["-c", "user.name=test", "-c", "user.email=test@example.com"];

interface WireRequest {
	jsonrpc?: string;
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
}

interface Harness {
	root: string;
	/** What stands for the other machine's filesystem. */
	remoteRoot: string;
	/** That machine's checkout. */
	remoteCwd: string;
	/** This machine's checkout (the local `cwd` / `localRepo`). */
	localCheckout: string;
	/** The bare repository both checkouts share. */
	origin: string;
	spawnRoot: string;
	wire(): WireRequest[];
	wireFor(method: HcMethod): Record<string, unknown>[];
	client: HcClient;
	supervisor: TerminalSupervisor;
	target: HostTarget;
	cleanup(): void;
}

const LIVE: Harness[] = [];
after(() => {
	for (const h of LIVE.splice(0)) h.cleanup();
});

function git(repo: string, args: readonly string[]): string {
	return execFileSync("git", ["-C", repo, ...GIT_ID, ...args], { encoding: "utf8" });
}

/**
 * Build the three repositories, the `HC_BIN` wrapper and a supervisor wired to
 * the fake core. `exec node <fake core>` uses THIS process's node, so the harness
 * never depends on the caller's PATH.
 */
function harness(options: { remoteIsRepo?: boolean } = {}): Harness {
	const root = mkdtempSync(path.join(tmpdir(), "remote-worktree-it-"));
	const origin = path.join(root, "origin.git");
	const localCheckout = path.join(root, "work-parent");
	const remoteRoot = path.join(root, "remote");
	const remoteCwd = path.join(remoteRoot, "work-remote");
	mkdirSync(remoteRoot, { recursive: true });

	execFileSync("git", ["init", "-q", "--bare", origin]);
	// Two checkouts, each with its own commit, both pointing at the SAME origin
	// (contract D10). Built with `init` rather than `clone` so nothing depends on
	// the clone-time refspec, and so `origin` can start empty.
	for (const checkout of [localCheckout, remoteCwd]) {
		execFileSync("git", ["init", "-q", "-b", "main", checkout]);
		execFileSync("git", ["-C", checkout, "remote", "add", "origin", origin]);
		execFileSync("git", ["-C", checkout, ...GIT_ID, "commit", "-q", "--allow-empty", "-m", `init ${path.basename(checkout)}`]);
	}
	// The parent pushes, so `origin` is not empty when the other side asks for it.
	execFileSync("git", ["-C", localCheckout, "push", "-q", "-u", "origin", "main"]);
	if (options.remoteIsRepo !== false) {
		// The other machine's checkout tracks the same shared history.
		execFileSync("git", ["-C", remoteCwd, "fetch", "-q", "origin"]);
		execFileSync("git", ["-C", remoteCwd, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "remote"]);
	}

	// Review M2: the preflight `test -f`s this package's entry on that machine,
	// because every child's argv loads it. The "operator" installed it here.
	mkdirSync(path.join(remoteRoot, ".pi-legion"), { recursive: true });
	writeFileSync(path.join(remoteRoot, ".pi-legion", "index.ts"), "// fake remote install\n");

	const binDir = path.join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	const wrapper = path.join(binDir, "hc");
	writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CORE)} "$@"\n`, { mode: 0o755 });
	chmodSync(wrapper, 0o755);
	const wirePath = path.join(root, "wire.jsonl");
	const spawnRoot = path.join(root, "spawn");
	mkdirSync(spawnRoot, { recursive: true });

	const env: NodeJS.ProcessEnv = {
		...process.env,
		HC_BIN: wrapper,
		HC_TERMINAL_SOCKET: SOCKET,
		HC_TERMINAL_ID: TERMINAL_ID,
		FAKE_HC_REMOTE_ROOT: remoteRoot,
		FAKE_HC_MACHINES: HOST,
		FAKE_HC_LOG: wirePath,
	};
	const real = new HcCliClient({ env, requestTimeoutMs: 20_000 });
	const client: HcClient = {
		start: () => real.start(),
		close: () => real.close(),
		request: async <T = unknown>(method: HcMethod, params: Record<string, unknown> = {}): Promise<T> =>
			(await real.request<T>(method, params)) as T,
	};
	const supervisor = new TerminalSupervisor({ clientFactory: () => client, env, runId: "run-xm-2", pollIntervalMs: 5, remoteStartupConfirmMs: 0 });
	// The package's own extension entry is in EVERY child's argv and cannot be
	// mapped by content, so the target says where it lives over there (D6).
	const target = resolveHostTarget(HOST, {
		enabled: true,
		hosts: {
			[HOST]: {
				cwd: remoteCwd,
				piLegionRoot: path.posix.join(remoteRoot, ".pi-legion"),
				// S5.6: the launch now asks the child's own argv one question before it
				// starts a terminal, so "pi" has to be something that machine can RUN.
				piCli: installFakePiCli(remoteRoot),
			},
		},
	});
	const wire = (): WireRequest[] => {
		if (!existsSync(wirePath)) return [];
		return readFileSync(wirePath, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as WireRequest);
	};
	const h: Harness = {
		root,
		remoteRoot,
		remoteCwd,
		localCheckout,
		origin,
		spawnRoot,
		wire,
		wireFor: (method) => wire().filter((request) => request.method === method).map((request) => request.params ?? {}),
		client,
		supervisor,
		target,
		cleanup: () => {
			const index = LIVE.indexOf(h);
			if (index >= 0) LIVE.splice(index, 1);
			try {
				client.close();
			} catch {
				/* already gone */
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
	LIVE.push(h);
	return h;
}

function agent(): AgentConfig {
	return {
		name: "centurion",
		description: "remote worktree test role",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a remote test centurion.",
		source: "user",
		filePath: "/fake/centurion.md",
		worktree: true,
	};
}

function spawnInput(h: Harness, overrides: Partial<SpawnInput> = {}): SpawnInput {
	return {
		name: CHILD_NAME,
		task: "Implement the slice.",
		agent: agent(),
		sessionFile: path.join(h.spawnRoot, "session.jsonl"),
		tempDir: h.spawnRoot,
		// THIS machine's checkout: the backend maps argv paths from here and the
		// shared-origin check asks this repository for its `origin`.
		cwd: h.localCheckout,
		env: { PI_LEGION_DB: path.join(h.spawnRoot, "legion.db"), PI_LEGION_NODE_ID: `root.${CHILD_NAME}` },
		cliPath: "/fake/pi/dist/cli.js",
		host: HOST,
		hostTarget: h.target,
		worktree: true,
		createWorktree: true,
		// A literal command instead of `npm-install`: the provision step must be
		// provably done ON THAT MACHINE, and `true` leaves its marker either way.
		worktreeBootstrap: "true",
		worktreeBootstrapTimeoutMs: 30_000,
		...overrides,
	};
}

// ── the happy path ─────────────────────────────────────────────────────────


/** A `pi` CLI the "remote" machine can actually run (S5.6's startup probe). */
function installFakePiCli(remoteRoot: string): string {
	const dir = path.join(remoteRoot, ".fake-pi");
	mkdirSync(dir, { recursive: true });
	const entry = path.join(dir, "cli.js");
	writeFileSync(entry, "#!/usr/bin/env node\nprocess.stdout.write('ok\\n');\n", { mode: 0o755 });
	return path.posix.join(remoteRoot, ".fake-pi", "cli.js");
}

test("S2: a remote worktree is created on that machine and the child starts inside it", async (t) => {
	const h = harness();
	t.after(() => h.cleanup());
	const handle = await h.supervisor.spawnChild(spawnInput(h));

	// 1. The tree exists ON THAT MACHINE, beside the checkout, not inside it.
	const treePath = remoteWorktreePathFor(h.target, CHILD_NAME);
	assert.equal(treePath, path.join(h.remoteRoot, ".pi-worktrees", CHILD_NAME));
	assert.ok(existsSync(treePath), `the fake remote must hold ${treePath}`);
	assert.equal(existsSync(path.join(h.remoteCwd, ".pi-worktrees")), false, "the tree is a sibling of the checkout");

	// 2. Its branch is the cross-machine namespace (D12), and it is really checked out.
	const branch = execFileSync("git", ["-C", treePath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
	assert.match(branch, new RegExp(`^pi-subagent/${HOST}/${CHILD_NAME}-[0-9a-f]{8}$`));
	const treeHead = execFileSync("git", ["-C", treePath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	assert.equal(treeHead, execFileSync("git", ["-C", h.remoteCwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), "the tree starts at that checkout's HEAD");

	// 3. Provisioning happened there: the marker is on the remote side only.
	// Review M4: the mirrored argv files live BESIDE the checkout, never inside the
	// tree the child delivers from.
	assert.equal(existsSync(path.join(h.remoteCwd, ".pi-subagents-remote")), false, "the mirror must not be inside the checkout");
	assert.equal(existsSync(path.join(h.remoteCwd, ".pi-subagents-mirror")), false, "the mirror must not be inside the checkout");
	assert.ok(
		existsSync(path.posix.join(path.dirname(h.remoteCwd), ".pi-subagents-mirror")),
		"the mirror must exist beside the checkout",
	);
	assert.ok(existsSync(path.join(treePath, ".pi-provisioned")), "the provision marker must be written on that machine");
	assert.equal(existsSync(path.join(h.localCheckout, ".pi-provisioned")), false);

	// 4. `terminal.run` started in the TREE (not the checkout), and carried no
	//    `caller`: a bare parent terminal id does not exist on that machine.
	// #409: a cross-machine launch creates the machine's anchor first, so the child's
	// own request is the one this case is about.
	const [run] = h.wireFor("terminal.run").filter((params) => params.name !== "lgl-anchor");
	assert.ok(run, "terminal.run must appear in the wire log");
	assert.equal(run.on, HOST);
	assert.equal(run.cwd, treePath);
	assert.equal("caller" in run, false, "a remote request must not carry the parent terminal id");
	const argv = (run.argv as string[]).map(String);
	assert.equal(argv[0], "node");
	// The fixture's runnable stub CLI on that machine (S5.6: the launch runs it once
	// before starting a terminal), never this machine's cli path.
	assert.ok(argv[1]!.startsWith(h.remoteRoot), `argv[1] must be the remote CLI: ${argv[1]}`);
	for (const arg of argv) {
		if (path.isAbsolute(arg)) assert.ok(arg.startsWith(h.remoteRoot), `a parent-absolute argv element survived: ${arg}`);
	}
	// The task text names the branch the child must push (D10/D12) …
	const task = argv[argv.length - 1]!;
	assert.match(task, new RegExp(`pi-subagent/${HOST}/${CHILD_NAME}-[0-9a-f]{8}`));
	// … and replaces the local "do not push" with a mandatory push.
	assert.match(task, /Push this branch to the shared remote when you are done/);
	assert.doesNotMatch(task, /do not push to main or master/);

	// 5. The handle carries the ownership pair back to the orchestrator (D13).
	assert.equal(handle.worktreePath, treePath);
	assert.equal(handle.worktreeBranch, branch);
	assert.equal(handle.worktreeHost, HOST);

	// 6. The parent never created a local tree.
	assert.equal(existsSync(path.join(h.localCheckout, ".pi-worktrees")), false);
});

test("S2/D10: the delivery channel closes — remote commit → push → parent fetch", async (t) => {
	const h = harness();
	t.after(() => h.cleanup());
	const handle = await h.supervisor.spawnChild(spawnInput(h));
	const treePath = handle.worktreePath!;
	const branch = handle.worktreeBranch!;

	// The remote child's work: one commit in ITS tree (D11 says delivery is git's job).
	writeFileSync(path.join(treePath, "slice.txt"), "delivered\n");
	execFileSync("git", ["-C", treePath, ...GIT_ID, "add", "slice.txt"]);
	execFileSync("git", ["-C", treePath, ...GIT_ID, "commit", "-q", "-m", "slice"]);
	const remoteSha = execFileSync("git", ["-C", treePath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	// Stands for the remote child's own `git push -u origin <branch>`: the same
	// command, run by this process, against the same shared remote.
	execFileSync("git", ["-C", treePath, ...GIT_ID, "push", "-q", "-u", "origin", branch]);

	// Before the fetch the parent knows nothing about it.
	assert.equal(remoteBranchTipOnOrigin(h.localCheckout, branch), undefined);
	const fetched = await fetchRemoteBranch({ localRepo: h.localCheckout, branch });
	assert.equal(fetched.sha, remoteSha, "the parent fetched the commit the child made");
	assert.equal(remoteBranchTipOnOrigin(h.localCheckout, branch), remoteSha);
	const remoteBranches = execFileSync("git", ["-C", h.localCheckout, "branch", "-r"], { encoding: "utf8" });
	assert.match(remoteBranches, new RegExp(`origin/${branch.replace(/[/.]/g, "\\$&")}`));
	// The work is really there, not just a ref.
	assert.equal(
		execFileSync("git", ["-C", h.localCheckout, "show", `${remoteSha}:slice.txt`], { encoding: "utf8" }),
		"delivered\n",
	);
});

// ── failures: named facts, and no terminal ─────────────────────────────────

test("S2: a configured cwd that does not exist is named as a missing checkout, and no terminal is created", async (t) => {
	const h = harness();
	t.after(() => h.cleanup());
	const missing = path.join(h.remoteRoot, "absent");
	const error = await h.supervisor
		.spawnChild(spawnInput(h, { hostTarget: { ...h.target, cwd: missing } }))
		.then(() => undefined, (thrown: unknown) => thrown);
	assert.ok(error instanceof SubagentError, `expected a SubagentError, got ${String(error)}`);
	// D6: the fact first, then the two ways out (a checkout there, or a worker).
	assert.equal(
		(error as SubagentError).message,
		`host 'fakebox' has no checkout at ${missing} (the configured cwd does not exist on that machine). Two ways out: 1) give that machine a checkout at ${missing} — git clone <url> ${missing} on 'fakebox' — or point subagents.crossMachine.hosts.fakebox.cwd at a directory that is a git checkout; 2) dispatch the centurion and let it create that role there (a role outside subagents.crossMachine.allowRoles cannot be dispatched from this session; the default is centurion).`,
	);
	assert.deepEqual(h.wireFor("terminal.run"), [], "no terminal may be created for a missing checkout");
});

test("S2: a cwd that is not a git repository is named as such, and no terminal is created", async (t) => {
	const h = harness({ remoteIsRepo: false });
	t.after(() => h.cleanup());
	// A plain directory on that machine: exists, is not a repo.
	const plain = path.join(h.remoteRoot, "not-a-repo");
	mkdirSync(plain, { recursive: true });
	rmSync(path.join(plain, ".git"), { recursive: true, force: true });
	const error = await h.supervisor
		.spawnChild(spawnInput(h, { hostTarget: { ...h.target, cwd: plain } }))
		.then(() => undefined, (thrown: unknown) => thrown);
	assert.ok(error instanceof SubagentError);
	assert.equal((error as SubagentError).code, ErrorCodes.INVALID_PARAMS);
	assert.equal(
		(error as SubagentError).message,
		`host 'fakebox': ${plain} is not a git repository on that machine. Two ways out: 1) give that machine a checkout at ${plain} — git clone <url> ${plain} on 'fakebox' — or point subagents.crossMachine.hosts.fakebox.cwd at a directory that is a git checkout; 2) dispatch the centurion and let it create that role there (a role outside subagents.crossMachine.allowRoles cannot be dispatched from this session; the default is centurion).`,
	);
	assert.deepEqual(h.wireFor("terminal.run"), []);
});

test("D5: a cwd that is not a checkout here is named as the SESSION's directory, and no terminal is created", async (t) => {
	// The real 6.2.0 session: the parent ran in `/Users/me/agents`, a plain directory.
	// The old answer told the operator to add an `origin` there, which is impossible.
	const h = harness();
	t.after(() => h.cleanup());
	const plain = path.join(h.root, "agents");
	mkdirSync(plain, { recursive: true });
	const error = await h.supervisor
		.spawnChild(spawnInput(h, { cwd: plain }))
		.then(() => undefined, (thrown: unknown) => thrown);
	assert.ok(error instanceof SubagentError, `expected a SubagentError, got ${String(error)}`);
	assert.equal((error as SubagentError).code, ErrorCodes.INVALID_PARAMS);
	const message = (error as SubagentError).message;
	assert.equal(message, notALocalCheckoutMessage({ host: HOST, localRepo: plain }));
	assert.doesNotMatch(message, /remote add/, "`git remote add` cannot work in a non-repository");
	assert.equal(
		message,
		`cross-machine delivery needs a git checkout on this machine too, and the directory it delivers from (${plain}) is not one. ` +
			"Two ways out: 1) run the launch from a checkout — start pi inside yours, or pass a relative cwd that points at one " +
			`plus hostCwd for the directory ON that machine: subagent({ agent: "centurion", host: "fakebox", cwd: "../my-repo", hostCwd: "/abs/path/on/fakebox", task: "..." }); ` +
			`2) dispatch the centurion instead and let IT create the worker on 'fakebox' — a role outside subagents.crossMachine.allowRoles cannot be dispatched from this session at all (the default list is ["centurion"]), while a scout or a worker is created ON that machine by the centurion running there.`,
	);
	// BUG B: no forbidden `subagent({ agent: "worker", … })` call in any message.
	assert.doesNotMatch(message, /subagent\(\{ agent: "worker"/);
	// The real spawn path stops before a tree or a terminal exists.
	assert.deepEqual(h.wireFor("terminal.run"), [], "no terminal may be created for a local non-checkout");
	const commands = h.wireFor("machine.exec").map((params) =>
		Array.isArray(params.argv) ? (params.argv as string[]).join(" ") : String(params.line ?? ""),
	);
	assert.equal(
		commands.some((command) => command.includes("worktree add")),
		false,
		`no worktree may be created: ${JSON.stringify(commands)}`,
	);
	assert.equal(existsSync(remoteWorktreePathFor(h.target, CHILD_NAME)), false);
});

test("S2/D10: a checkout whose origin differs is refused, naming BOTH remotes", async (t) => {
	const h = harness();
	t.after(() => h.cleanup());
	// A second bare repository: the other machine is pointed somewhere else.
	const otherOrigin = path.join(h.root, "other-origin.git");
	execFileSync("git", ["init", "-q", "--bare", otherOrigin]);
	execFileSync("git", ["-C", h.remoteCwd, "remote", "set-url", "origin", otherOrigin]);
	const error = await h.supervisor
		.spawnChild(spawnInput(h))
		.then(() => undefined, (thrown: unknown) => thrown);
	assert.ok(error instanceof SubagentError);
	assert.equal((error as SubagentError).code, ErrorCodes.INVALID_PARAMS);
	const message = (error as SubagentError).message;
	assert.equal(
		message,
		`host 'fakebox': its checkout at ${h.remoteCwd} has origin '${otherOrigin}' but this checkout's is '${h.origin}'; cross-machine delivery needs one shared remote. Two ways out: 1) make both sides point at one url (git remote set-url origin <url> on either side); 2) dispatch the centurion and let it create that role there (a role outside subagents.crossMachine.allowRoles cannot be dispatched from this session; the default is centurion).`,
	);
	assert.deepEqual(h.wireFor("terminal.run"), []);
	// The destination was never even attempted.
	assert.equal(existsSync(remoteWorktreePathFor(h.target, CHILD_NAME)), false);
});
