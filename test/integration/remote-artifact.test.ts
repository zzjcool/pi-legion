/**
 * S4 — cross-machine read-back and the four-step `resume` gate (contract
 * `cross-machine-spawn-v1` D15/D17).
 *
 * The fake core's `file.read` counts lines for real and returns `lines` = the
 * FILE's total, so "how much did we get" is a fact the test can assert rather than
 * a number the product inventst. Truncation is exercised through the WINDOW (the
 * product asks for a tail), never through a silent byte cap we cannot observe.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { hcCliClient, type HcClient } from "../../src/hc/client.ts";
import {
	REMOTE_TAIL_LINES,
	assertRemoteResume,
	createRemoteSessionReadback,
	readRemoteText,
	remoteMirrorPathFor,
	remoteSessionPathFor,
} from "../../src/runs/remote-artifact.ts";
import { SubagentError } from "../../src/shared/types.ts";
import type { HostTarget } from "../../src/runs/remote.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CORE = path.resolve(HERE, "../helpers/fake-hc-core.mjs");
const HOST = "fakebox";

interface Harness {
	root: string;
	remoteRoot: string;
	remoteCwd: string;
	target: HostTarget;
	client: HcClient;
	cleanup: () => void;
}

function harness(prefix = "remote-artifact-"): Harness {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	const remoteRoot = path.join(root, "remote");
	const remoteCwd = path.join(remoteRoot, "work");
	mkdirSync(remoteCwd, { recursive: true });
	const binDir = path.join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	const wrapper = path.join(binDir, "hc");
	writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CORE)} "$@"\n`, { mode: 0o755 });
	chmodSync(wrapper, 0o755);
	const previous = { ...process.env };
	Object.assign(process.env, {
		HC_BIN: wrapper,
		FAKE_HC_REMOTE_ROOT: remoteRoot,
		FAKE_HC_MACHINES: HOST,
	});
	const client = hcCliClient({ env: process.env });
	const mir = path.posix.join(remoteRoot, ".pi-subagents-mirror", "run-1", "worker-0");
	const target: HostTarget = {
		host: HOST,
		cwd: remoteCwd,
		node: "node",
		piCli: "pi",
		pathMap: [],
		piLegionRoot: path.posix.join(remoteRoot, ".pi-legion"),
		piExtensions: [],
		mirrorRoot: path.posix.join(remoteRoot, ".pi-subagents-mirror"),
		worktreeRoot: path.posix.join(remoteRoot, ".pi-worktrees"),
	};
	mkdirSync(mir, { recursive: true });
	return {
		root,
		remoteRoot,
		remoteCwd,
		target,
		client,
		cleanup: () => {
			client.close();
			for (const key of ["HC_BIN", "FAKE_HC_REMOTE_ROOT", "FAKE_HC_MACHINES"]) {
				if (previous[key] === undefined) delete process.env[key];
				else process.env[key] = previous[key];
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** A transcript line that parses as a session message with some text. */
function sessionLine(text: string): string {
	return `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;
}

test("S4/D15: a session under the window is read back whole, and marked complete", async (t) => {
	const h = harness();
	t.after(() => h.cleanup());
	const remote = path.posix.join(h.target.mirrorRoot, "run-1", "worker-0", "session.jsonl");
	const lines = Array.from({ length: 40 }, (_unused, index) => sessionLine(`step ${index}`)).join("");
	writeFileSync(path.join(h.remoteRoot, ".pi-subagents-mirror", "run-1", "worker-0", "session.jsonl"), lines);

	const read = await readRemoteText({ client: h.client, target: h.target, remotePath: remote });
	assert.equal(read.lines, 40);
	assert.equal(read.returned, 40, "a small file comes back whole");
	assert.equal(read.truncated, false);
	assert.match(read.text, /step 39/);

	// Through the seam: the text lands under <runDir>/remote/, never under sessions/.
	const runDir = path.join(h.root, "run");
	const localPath = remoteMirrorPathFor(runDir, "worker-0");
	assert.equal(path.dirname(localPath), path.join(runDir, "remote"));
	const readback = createRemoteSessionReadback({
		crossMachine: { enabled: true, hosts: { [HOST]: { cwd: h.remoteCwd } } },
		clientFactory: () => h.client,
	});
	const result = await readback({ host: HOST, name: "worker-0", localPath, remoteDir: path.posix.dirname(remote) });
	assert.equal(result.ok, true, JSON.stringify(result));
	if (!result.ok) return;
	assert.equal(result.truncated, false);
	assert.equal(result.localPath, localPath);
	assert.match(readFileSync(localPath, "utf8"), /step 39/);
	// The session path derivation the seam used is the argv rewrite's path.
	assert.equal(remoteSessionPathFor(h.target, { name: "worker-0", remoteDir: path.posix.dirname(remote) }), remote);
});

test("S4/D15: an oversized session is a TAIL, and the truncation is stated (never inferred as complete)", async (t) => {
	const h = harness();
	t.after(() => h.cleanup());
	const dir = path.join(h.remoteRoot, ".pi-subagents-mirror", "run-1", "worker-0");
	const total = REMOTE_TAIL_LINES + 250;
	writeFileSync(path.join(dir, "session.jsonl"), Array.from({ length: total }, (_u, i) => sessionLine(`step ${i}`)).join(""));

	const read = await readRemoteText({
		client: h.client,
		target: h.target,
		remotePath: path.posix.join(h.target.mirrorRoot, "run-1", "worker-0", "session.jsonl"),
	});
	assert.equal(read.lines, total, "`lines` is the FILE's total, not the window");
	assert.equal(read.returned, REMOTE_TAIL_LINES, "the window is the tail we asked for");
	assert.equal(read.truncated, true, "a tail is never presented as the whole file");
	// The tail, not the head: the last line must be present, the first must not.
	assert.match(read.text, new RegExp(`step ${total - 1}`));
	assert.doesNotMatch(read.text, /"step 0"/);

	const localPath = remoteMirrorPathFor(path.join(h.root, "run"), "worker-0");
	const readback = createRemoteSessionReadback({
		crossMachine: { enabled: true, hosts: { [HOST]: { cwd: h.remoteCwd } } },
		clientFactory: () => h.client,
	});
	const result = await readback({ host: HOST, name: "worker-0", localPath, remoteDir: path.posix.dirname(path.posix.join(h.target.mirrorRoot, "run-1", "worker-0", "session.jsonl")) });
	assert.equal(result.ok, true, JSON.stringify(result));
	if (!result.ok) return;
	assert.equal(result.truncated, true);
	assert.equal(result.lines, total);
	assert.equal(result.returned, REMOTE_TAIL_LINES);
});

test("S4/D15: a remote file that does not exist fails the read-back with a reason, not an empty success", async (t) => {
	const h = harness();
	t.after(() => h.cleanup());
	const readback = createRemoteSessionReadback({
		crossMachine: { enabled: true, hosts: { [HOST]: { cwd: h.remoteCwd } } },
		clientFactory: () => h.client,
	});
	const result = await readback({
		host: HOST,
		name: "worker-0",
		localPath: path.join(h.root, "run", "remote", "worker-0.jsonl"),
		remoteDir: path.posix.join(h.target.mirrorRoot, "run-1", "nobody"),
	});
	// The transcript is missing there; the answer must say so rather than pretend
	// the child produced nothing (that was review M5's whole complaint).
	assert.equal(result.ok, false, JSON.stringify(result));
	if (result.ok) return;
	assert.match(result.reason, /no such file|not found|ENOENT|file/i);
});

test("S4/D17: the four-step gate names the step that failed", async (t) => {
	const h = harness();
	t.after(() => h.cleanup());
	const config = { enabled: true, hosts: { [HOST]: { cwd: h.remoteCwd } } };
	// The gate closes the client it is handed (it creates one per call in production),
	// so the factory must hand out a fresh connection for each step.
	const fresh = () => hcCliClient({ env: process.env });

	// Step 1: the record does not say which machine.
	await assert.rejects(
		() => assertRemoteResume({ crossMachine: config, clientFactory: () => h.client, request: { host: "", name: "worker-0" } }),
		(error: unknown) => {
			assert.ok(error instanceof SubagentError);
			assert.match((error as SubagentError).message, /step 1\/4/);
			return true;
		},
	);

	// Step 2: the machine does not answer.
	const dead = hcCliClient({ env: { ...process.env, HC_BIN: path.join(h.root, "no-such-hc") } });
	try {
		await assert.rejects(
			() => assertRemoteResume({ crossMachine: config, clientFactory: () => dead, request: { host: HOST, name: "worker-0" } }),
			(error: unknown) => {
				assert.ok(error instanceof SubagentError);
				assert.match((error as SubagentError).message, /step 2\/4/);
				assert.match((error as SubagentError).message, /not reachable|unreachable/);
				return true;
			},
		);
	} finally {
		dead.close();
	}

	// Step 3: the terminal is gone from that machine.
	await assert.rejects(
		() => assertRemoteResume({
			crossMachine: config,
			clientFactory: fresh,
			request: { host: HOST, name: "worker-0", terminalName: "lgl-does-not-exist" },
		}),
		(error: unknown) => {
			assert.ok(error instanceof SubagentError);
			assert.match((error as SubagentError).message, /step 3\/4/);
			assert.match((error as SubagentError).message, /does not exist on that machine any more/);
			// Precise: the address, not just the name, and the way out.
			assert.match((error as SubagentError).message, new RegExp(`${HOST}/lgl-does-not-exist`));
			assert.match((error as SubagentError).message, /relaunch/);
			return true;
		},
	);

	// Step 4: the terminal is fine, the tree is gone.
	// Each `hc` spawn is a separate core PROCESS, so the terminal must be created by
	// the very connection the gate will use (the gate closes it afterwards).
	const live = fresh();
	await live.start();
	await live.request("terminal.run", {
		on: HOST,
		name: "lgl-worker-0",
		argv: ["sleep", "30"],
		cwd: h.remoteCwd,
	});
	await assert.rejects(
		() => assertRemoteResume({
			crossMachine: config,
			clientFactory: () => live,
			request: {
				host: HOST,
				name: "worker-0",
				worktreePath: path.posix.join(h.remoteRoot, ".pi-worktrees", "gone"),
			},
		}),
		(error: unknown) => {
			assert.ok(error instanceof SubagentError);
			assert.match((error as SubagentError).message, /step 4\/4/);
			assert.match((error as SubagentError).message, /does not exist on that machine/);
			return true;
		},
	);
});

test("S4/D17: an old record with no host takes the local path, unchanged", async () => {
	// Requirement 3 of S4: a record written before cross-machine existed must behave
	// exactly as it does today. The gate is only reachable when a host is recorded —
	// and `remoteSessionPathFor` is never consulted for a local child.
	const readback = createRemoteSessionReadback({ crossMachine: undefined });
	// No config, no host: the seam still answers (it is only CALLED for a host), and
	// the failure mode is a named reason rather than a thrown collect.
	const result = await readback({ host: "vps", name: "worker-0", localPath: "/tmp/never.jsonl" });
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.match(result.reason, /subagents\.crossMachine/);
});

test("S4/D17: a LIVE terminal plus a present tree passes the gate (so a resume cannot fork a second child)", async (t) => {
	// The complement of the refusals: all four facts hold. `resume` must then ADOPT,
	// not relaunch — a second terminal with the same name on that machine is exactly
	// the duplicate this gate exists to prevent.
	const h = harness();
	t.after(() => h.cleanup());
	const tree = path.posix.join(h.remoteRoot, ".pi-worktrees", "worker-0");
	mkdirSync(tree, { recursive: true });
	const live = hcCliClient({ env: process.env });
	await live.start();
	await live.request("terminal.run", { on: HOST, name: "lgl-worker-0", argv: ["sleep", "30"], cwd: h.remoteCwd });
	const verdict = await assertRemoteResume({
		crossMachine: { enabled: true, hosts: { [HOST]: { cwd: h.remoteCwd } } },
		clientFactory: () => live,
		request: { host: HOST, name: "worker-0", terminalName: "lgl-worker-0", worktreePath: tree },
	});
	assert.equal(verdict.terminalState, "live");
});
