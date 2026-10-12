import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	currentPgid,
	enumerateDescendants,
	parseProcStatLine,
} from "../../src/supervisor/proc-tree.ts";

function delay(timeoutMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function waitForClose(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			child.off("close", finish);
			resolve();
		};
		const timer = setTimeout(finish, timeoutMs);
		child.once("close", finish);
	});
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		// The test process tree may have already exited or been reaped.
	}
}

test(
	"enumerateDescendants finds a spawned sh and sleep process tree",
	{ skip: process.platform !== "linux" },
	async () => {
		const child = spawn("sh", ["-c", "sleep 300 & echo $!; wait"], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		const spawnedPids = new Set<number>();
		if (child.pid !== undefined) spawnedPids.add(child.pid);

		try {
			const stdout = child.stdout;
			assert.ok(stdout, "the shell stdout pipe should be available");
			const sleepPid = await new Promise<number>((resolve, reject) => {
				let output = "";
				const cleanup = () => {
					clearTimeout(timer);
					stdout.off("data", onData);
					child.off("error", onError);
				};
				const onData = (chunk: Buffer | string) => {
					output += chunk.toString();
					const newline = output.indexOf("\n");
					if (newline < 0) return;
					const pid = Number(output.slice(0, newline).trim());
					cleanup();
					if (!Number.isSafeInteger(pid) || pid <= 0) {
						reject(new Error(`shell returned an invalid sleep PID: ${output}`));
						return;
					}
					resolve(pid);
				};
				const onError = (error: Error) => {
					cleanup();
					reject(error);
				};
				const timer = setTimeout(() => {
					cleanup();
					reject(new Error("timed out waiting for shell to report the sleep PID"));
				}, 2_000);
				stdout.on("data", onData);
				child.once("error", onError);
			});
			spawnedPids.add(sleepPid);

			const expectedPgid = currentPgid();
			assert.notEqual(expectedPgid, null, "Linux /proc should expose the test process group");
			let descendants: ReturnType<typeof enumerateDescendants> = [];
			const deadline = Date.now() + 2_000;
			do {
				descendants = enumerateDescendants(process.pid);
				if (
					descendants.some((descendant) => descendant.pid === child.pid) &&
					descendants.some((descendant) => descendant.pid === sleepPid)
				) {
					break;
				}
				await delay(20);
			} while (Date.now() < deadline);

			const shell = descendants.find((descendant) => descendant.pid === child.pid);
			const sleep = descendants.find((descendant) => descendant.pid === sleepPid);
			assert.equal(
				descendants.some((descendant) => descendant.pid === process.pid),
				false,
				"the root process must not be included in its descendants",
			);
			assert.ok(shell, "the intermediate sh process should be enumerated");
			assert.ok(sleep, "the sleep child process should be enumerated");
			assert.equal(shell.pgid, expectedPgid);
			assert.equal(sleep.pgid, expectedPgid);
		} finally {
			const descendants = enumerateDescendants(process.pid);
			for (const { pid } of descendants) {
				if (spawnedPids.has(pid)) continue;
				try {
					const stat = parseProcStatLine(readFileSync(`/proc/${pid}/stat`, "utf8"));
					if (stat && spawnedPids.has(stat.ppid)) spawnedPids.add(pid);
				} catch {
					// Skip descendants that disappeared during cleanup discovery.
				}
			}
			for (const pid of spawnedPids) signalPid(pid, "SIGTERM");
			child.kill("SIGTERM");
			await waitForClose(child, 500);
			for (const pid of spawnedPids) signalPid(pid, "SIGKILL");
			child.kill("SIGKILL");
			await waitForClose(child, 1_000);
		}
	},
);

test("enumerateDescendants returns empty for a missing root pid", () => {
	assert.deepEqual(enumerateDescendants(999_999_999), []);
});

test("parseProcStatLine handles parenthesized comm and rejects malformed rows", () => {
	assert.deepEqual(
		parseProcStatLine("12345 (node worker (with spaces)) S 234 345 345 0 0 0"),
		{ pid: 12345, ppid: 234, pgid: 345 },
	);
	assert.equal(parseProcStatLine("not a proc stat row"), null);
	assert.equal(parseProcStatLine("123 (worker) S nope 1 2"), null);
});
