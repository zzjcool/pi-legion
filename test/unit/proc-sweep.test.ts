/**
 * #310: a timed-out / aborted verify command used to leave its grandchildren
 * running (`ppid=1`, observed alive 44 minutes after the run). The fix has two
 * halves and both are covered here:
 *
 *  - `sweepProcessTree` / `survivingDescendants` (the shared primitive);
 *  - the two execution points that now spawn detached and sweep on the
 *    timeout / output-cap / abort paths, while leaving a clean exit alone.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	commandSummary,
	survivingDescendants,
	sweepProcessTree,
} from "../../src/shared/proc-sweep.ts";
import { enumerateDescendants, currentPgid, parseProcStatLine } from "../../src/supervisor/proc-tree.ts";
import { runVerifyCommand } from "../../src/runs/acceptance.ts";
import { runLegionCommandNow } from "../../src/extension/legion-tools.ts";

const linuxOnly = { skip: process.platform !== "linux" ? "procfs-only assertions" : false } as const;
/** Fast sweep windows so the suite does not pay the production grace per case. */
const FAST_SWEEP = { graceMs: 100, killAfterMs: 200 } as const;
const TERM_IGNORING_LOOP = "trap '' TERM; while :; do sleep 0.2; done";

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException | null)?.code === "EPERM";
	}
	if (process.platform !== "linux") return true;
	let stat: string;
	try {
		stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return true;
	}
	const commEnd = stat.lastIndexOf(")");
	return commEnd < 0 || !stat.slice(commEnd + 1).trimStart().startsWith("Z");
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return predicate();
}

function tempDir(): string {
	return mkdtempSync(path.join(tmpdir(), "proc-sweep-"));
}

function readPidFile(file: string): number {
	const pid = Number(readFileSync(file, "utf8").trim());
	assert.ok(Number.isSafeInteger(pid) && pid > 0, `pid file ${file} should hold a pid`);
	return pid;
}

/** Process group of a live pid, read the same way the sweep reads it. */
function procPgid(pid: number): number {
	const stat = parseProcStatLine(readFileSync(`/proc/${pid}/stat`, "utf8"));
	assert.ok(stat, `should parse /proc/${pid}/stat`);
	return stat.pgid;
}

/** Spawn `sh -c <script>` in its own process group and read its first stdout line. */
function spawnDetached(script: string): { child: ReturnType<typeof spawn>; firstLine: Promise<string> } {
	const child = spawn("sh", ["-c", script], {
		detached: true,
		stdio: ["ignore", "pipe", "ignore"],
	});
	const firstLine = new Promise<string>((resolve, reject) => {
		let buffered = "";
		const stdout = child.stdout;
		assert.ok(stdout, "stdout pipe should exist");
		stdout.on("data", (chunk: Buffer | string) => {
			buffered += chunk.toString();
			const newline = buffered.indexOf("\n");
			if (newline < 0) return;
			resolve(buffered.slice(0, newline).trim());
		});
		child.once("error", reject);
		child.once("close", () => reject(new Error(`shell closed before printing a line: ${buffered}`)));
	});
	// Callers that never read the line must not trip an unhandled rejection.
	void firstLine.catch(() => undefined);
	return { child, firstLine };
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 10_000): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, timeoutMs);
		child.once("close", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

test("sweepProcessTree kills every grandchild in the process group", linuxOnly, async () => {
	const { child, firstLine } = spawnDetached("sleep 300 & echo $!; sleep 300");
	const rootPid = child.pid;
	assert.ok(rootPid !== undefined, "the shell should have a pid");
	try {
		const grandchild = Number(await firstLine);
		assert.ok(pidAlive(grandchild), "the background sleep should be running");
		assert.ok(
			enumerateDescendants(rootPid).some((d) => d.pid === grandchild),
			"procfs should see the grandchild before the sweep",
		);

		const result = await sweepProcessTree(rootPid, FAST_SWEEP);
		assert.equal(result.signaled >= 1, true, "the process group takes the first signal");
		assert.deepEqual(result.survivors, [], "nothing survives a sweep");
		assert.equal(pidAlive(grandchild), false, "the grandchild is gone");
		assert.equal(pidAlive(rootPid), false, "the shell itself is gone");
	} finally {
		await sweepProcessTree(rootPid, { graceMs: 20, killAfterMs: 20 });
	}
});

test("sweepProcessTree kills a descendant that escaped the group with setsid", linuxOnly, async () => {
	const { child, firstLine } = spawnDetached(
		"setsid sleep 300 >/dev/null 2>&1 & echo $!; sleep 300",
	);
	const rootPid = child.pid;
	assert.ok(rootPid !== undefined, "the shell should have a pid");
	try {
		const escaped = Number(await firstLine);
		assert.ok(pidAlive(escaped), "the setsid'ed sleep should be running");
		// `setsid` runs after exec, so the new session id lands a moment later.
		assert.equal(
			await waitFor(() =>
				enumerateDescendants(rootPid).find((d) => d.pid === escaped)?.pgid !== rootPid,
			),
			true,
			"the escapee must not share the shell's process group",
		);

		const result = await sweepProcessTree(rootPid, FAST_SWEEP);
		assert.deepEqual(result.survivors, []);
		assert.equal(pidAlive(escaped), false, "the per-pid fallback reaches a setsid escapee");
	} finally {
		await sweepProcessTree(rootPid, { graceMs: 20, killAfterMs: 20 });
	}
});

test("sweepProcessTree escalates to SIGKILL for a descendant that ignores SIGTERM", linuxOnly, async () => {
	const dir = tempDir();
	const ready = path.join(dir, "ready");
	const { child, firstLine } = spawnDetached(
		`sh -c "trap '' TERM; echo ready > ${ready}; ${TERM_IGNORING_LOOP}" & echo $!; sleep 300`,
	);
	const rootPid = child.pid;
	assert.ok(rootPid !== undefined, "the shell should have a pid");
	try {
		const stubborn = Number(await firstLine);
		// The trap must be installed before the first signal, or the shell dies
		// on SIGTERM and the escalation path is never exercised.
		assert.equal(await waitFor(() => existsSync(ready)), true, "the TERM trap is installed");
		const result = await sweepProcessTree(rootPid, FAST_SWEEP);
		assert.ok(result.killed >= 1, "the TERM-ignoring descendant is SIGKILLed");
		assert.deepEqual(result.survivors, []);
		assert.equal(pidAlive(stubborn), false);
	} finally {
		await sweepProcessTree(rootPid, { graceMs: 20, killAfterMs: 20 });
		rmSync(dir, { recursive: true, force: true });
	}
});

test("sweepProcessTree swallows ESRCH for pids that never existed", async () => {
	const missing = 2_147_483_600;
	assert.deepEqual(await sweepProcessTree(missing, { graceMs: 20, killAfterMs: 20 }), {
		signaled: 0,
		killed: 0,
		survivors: [],
	});
	assert.deepEqual(await sweepProcessTree(0), { signaled: 0, killed: 0, survivors: [] });
	assert.deepEqual(await sweepProcessTree(Number.NaN), { signaled: 0, killed: 0, survivors: [] });
});

test("sweepProcessTree counts a delivered signal and reports no survivors", linuxOnly, async () => {
	const { child } = spawnDetached("sleep 300");
	const rootPid = child.pid;
	assert.ok(rootPid !== undefined);
	try {
		const result = await sweepProcessTree(rootPid, FAST_SWEEP);
		assert.equal(result.signaled, 1, "one successful group signal, no enumerated descendants");
		assert.equal(result.killed, 0, "SIGTERM was enough, so no SIGKILL is counted");
		assert.deepEqual(result.survivors, []);
	} finally {
		await sweepProcessTree(rootPid, { graceMs: 20, killAfterMs: 20 });
	}
});

test("survivingDescendants still sees a leftover after the shell exited", linuxOnly, async () => {
	const { child, firstLine } = spawnDetached("sleep 300 >/dev/null 2>&1 & echo $!; sleep 300");
	const rootPid = child.pid;
	assert.ok(rootPid !== undefined);
	try {
		const leftover = Number(await firstLine);
		// Reap only the shell: the leftover is reparented to init and drops out
		// of rootPid's /proc parent chain, exactly like a real orphan.
		process.kill(rootPid, "SIGKILL");
		await waitForExit(child);
		assert.deepEqual(
			enumerateDescendants(rootPid).map((d) => d.pid),
			[],
			"the parent chain is gone",
		);
		assert.ok(
			survivingDescendants(rootPid).includes(leftover),
			"the process-group scan still finds the leftover",
		);
	} finally {
		await sweepProcessTree(rootPid, { graceMs: 20, killAfterMs: 20 });
	}
});

test("commandSummary flattens and caps a multi-line command", () => {
	assert.equal(commandSummary("npm run a\n  && npm run b"), "npm run a && npm run b");
	const capped = commandSummary("x".repeat(200), 20);
	assert.equal(capped.length, 20);
	assert.ok(capped.endsWith("…"));
});

/** Best-effort hard kill for test cleanup; never throws. */
function hardKill(pid: number): void {
	if (!Number.isSafeInteger(pid) || pid <= 0) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// already gone
	}
}

/** Sweep a test's own process group, then anything else it left behind by pid. */
async function cleanUp(groupLeader: number, ...pids: number[]): Promise<void> {
	await sweepProcessTree(groupLeader, { graceMs: 20, killAfterMs: 100 });
	for (const pid of pids) hardKill(pid);
}

test("a timed-out verify command sweeps its tree before resolving", linuxOnly, async () => {
	const dir = tempDir();
	const shellFile = path.join(dir, "shell.pid");
	const bgFile = path.join(dir, "bg.pid");
	try {
		// Both halves hang: the direct `sleep 300` is the shell's foreground
		// child and the first one is the grandchild that used to be orphaned.
		const result = await runVerifyCommand(
			`echo $$ > ${shellFile}; sleep 300 & echo $! > ${bgFile}; sleep 300`,
			dir,
			500,
		);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /verification timed out after 500ms/);
		assert.equal(
			pidAlive(readPidFile(bgFile)),
			false,
			"the grandchild must already be gone when the timeout result resolves",
		);
		assert.equal(pidAlive(readPidFile(shellFile)), false, "the shell is gone too");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an aborted verify command sweeps its tree before resolving", linuxOnly, async () => {
	const dir = tempDir();
	const pidFile = path.join(dir, "shell.pid");
	const controller = new AbortController();
	try {
		const pending = runVerifyCommand(`echo $$ > ${pidFile}; sleep 300`, dir, 30_000, controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 150));
		const shellPid = readPidFile(pidFile);
		assert.ok(pidAlive(shellPid), "the shell is running when the abort arrives");
		assert.equal(
			procPgid(shellPid),
			shellPid,
			"the shell leads its own process group (spawned detached)",
		);
		controller.abort();
		const result = await pending;
		assert.equal(result.code, 1);
		assert.match(result.stderr, /aborted/);
		assert.equal(pidAlive(shellPid), false, "abort sweeps before resolving");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a clean verify exit leaves `cmd &` alone and warns once", linuxOnly, async () => {
	const dir = tempDir();
	const pidFile = path.join(dir, "bg.pid");
	const shellFile = path.join(dir, "shell.pid");
	const warnings: string[] = [];
	const realWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map((arg) => String(arg)).join(" "));
	};
	let leftover = 0;
	try {
		const result = await runVerifyCommand(
			`echo $$ > ${shellFile}; sleep 300 >/dev/null 2>&1 & echo $! > ${pidFile}`,
			dir,
			10_000,
		);
		assert.equal(result.code, 0, "a clean exit stays a clean exit");
		leftover = readPidFile(pidFile);
		assert.equal(pidAlive(leftover), true, "a background process from a clean exit is legal");
		assert.equal(
			procPgid(leftover),
			readPidFile(shellFile),
			"the leftover still names the command's own process group (spawned detached)",
		);
		assert.equal(warnings.length, 1, "exactly one leftover warning");
		assert.match(warnings[0]!, /leaving 1 process\(es\) running/);
		assert.match(warnings[0]!, /sleep 300/);
		assert.match(warnings[0]!, new RegExp(`${leftover}`), "the warning names the pid");
	} finally {
		console.warn = realWarn;
		await cleanUp(readPidFile(shellFile), leftover);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a timed-out legion verify command sweeps its tree before resolving", linuxOnly, async () => {
	const dir = tempDir();
	const pidFile = path.join(dir, "shell.pid");
	let shellPid = 0;
	try {
		// The shell ignores SIGTERM, so only the sweep's SIGKILL escalation can
		// end it — the `timeout` binary in front of it cannot (`--signal=TERM`).
		const pending = runLegionCommandNow(`echo $$ > ${pidFile}; ${TERM_IGNORING_LOOP}`, dir, 100);
		assert.equal(await waitFor(() => existsSync(pidFile)), true, "the shell starts");
		shellPid = readPidFile(pidFile);
		assert.notEqual(
			procPgid(shellPid),
			currentPgid(),
			"the command runs outside the host's process group (spawned detached)",
		);
		const result = await pending;
		assert.equal(result.timedOut, true);
		assert.equal(result.code, 1);
		assert.equal(
			pidAlive(shellPid),
			false,
			"the term-ignoring shell is gone before the result resolves",
		);
	} finally {
		hardKill(shellPid);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a clean legion verify exit leaves `cmd &` alone and warns once", linuxOnly, async () => {
	const dir = tempDir();
	const pidFile = path.join(dir, "bg.pid");
	const warnings: string[] = [];
	const realWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map((arg) => String(arg)).join(" "));
	};
	let leftover = 0;
	try {
		const result = await runLegionCommandNow(
			`sleep 300 >/dev/null 2>&1 & echo $! > ${pidFile}`,
			dir,
			10_000,
		);
		assert.equal(result.code, 0);
		leftover = readPidFile(pidFile);
		assert.equal(pidAlive(leftover), true, "a clean exit never kills a background process");
		assert.notEqual(
			procPgid(leftover),
			currentPgid(),
			"the command runs outside the host's process group (spawned detached)",
		);
		assert.equal(warnings.length, 1, "exactly one leftover warning");
		assert.match(warnings[0]!, /leaving 1 process\(es\) running/);
	} finally {
		console.warn = realWarn;
		hardKill(leftover);
		rmSync(dir, { recursive: true, force: true });
	}
});
