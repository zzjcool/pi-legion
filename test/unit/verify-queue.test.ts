import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
	DEFAULT_VERIFY_CONCURRENCY,
	DEFAULT_VERIFY_QUEUE_MAX_MS,
	acquireVerifySlot,
	inspectVerifySlots,
	resolveVerifyQueueConfig,
	queueNote,
	setVerifyQueueListener,
	type VerifyQueueEvent,
} from "../../src/runs/verify-queue.ts";

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "vq-"));

test("config from env; 0 = unlimited", async () => {
	const c = resolveVerifyQueueConfig({ PI_LEGION_VERIFY_CONCURRENCY: "3", PI_LEGION_VERIFY_QUEUE_MAX_MS: "1000", PI_LEGION_VERIFY_LOCK_DIR: "/x" });
	assert.deepEqual(c, { limit: 3, maxWaitMs: 1000, lockDir: "/x" });
	assert.equal(resolveVerifyQueueConfig({}).limit, 2);
	const s = await acquireVerifySlot("c", { limit: 0, maxWaitMs: 0, lockDir: "/nonexistent/x" });
	assert.equal(s.overflow, false);
});

test("in-process: at most `limit` holders; waiter proceeds after release; queue wait reported", async () => {
	const lockDir = dir();
	const cfg = { limit: 2, maxWaitMs: 10_000, lockDir };
	const a = await acquireVerifySlot("a", cfg);
	const b = await acquireVerifySlot("b", cfg);
	let cGot = false;
	const cP = acquireVerifySlot("c", cfg).then((s) => { cGot = true; return s; });
	await new Promise((r) => setTimeout(r, 1200));
	assert.equal(cGot, false);
	a.release();
	const c = await cP;
	assert.ok(c.waitedMs >= 1000);
	assert.match(queueNote(c, 2), /waited \d+s for one of 2 slots/);
	b.release(); c.release();
	assert.deepEqual(fs.readdirSync(lockDir), []);
});

test("stale slot of a dead pid is reclaimed", async () => {
	const lockDir = dir();
	for (const i of [0, 1]) fs.writeFileSync(path.join(lockDir, `slot-${i}.lock`), JSON.stringify({ pid: 2 ** 22 + 7, host: os.hostname(), at: 0 }));
	const s = await acquireVerifySlot("x", { limit: 2, maxWaitMs: 2_000, lockDir });
	assert.equal(s.overflow, false);
	assert.ok(s.waitedMs < 1_000);
	s.release();
});

test("overall cap: hung live holder → runs unthrottled after maxWaitMs", async () => {
	const lockDir = dir();
	fs.writeFileSync(path.join(lockDir, "slot-0.lock"), JSON.stringify({ pid: process.pid, host: os.hostname(), at: 0 }));
	const s = await acquireVerifySlot("x", { limit: 1, maxWaitMs: 800, lockDir });
	assert.equal(s.overflow, true);
	assert.match(queueNote(s, 1), /cap reached/);
});

test("cross-process: 5 processes, never more than 2 concurrent", async () => {
	const lockDir = dir();
	const log = path.join(lockDir, "..", `vq-log-${process.pid}-${Date.now()}`);
	const script = `
		import { acquireVerifySlot } from ${JSON.stringify(path.resolve("src/runs/verify-queue.ts"))};
		import * as fs from "node:fs";
		const s = await acquireVerifySlot("t", { limit: 2, maxWaitMs: 60000, lockDir: ${JSON.stringify(lockDir)} });
		fs.appendFileSync(${JSON.stringify(log)}, "+\\n");
		await new Promise((r) => setTimeout(r, 700));
		fs.appendFileSync(${JSON.stringify(log)}, "-\\n");
		s.release();`;
	await Promise.all(Array.from({ length: 5 }, () => new Promise<void>((resolve, reject) => {
		const c = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { stdio: "ignore" });
		c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
	})));
	let cur = 0, max = 0;
	for (const l of fs.readFileSync(log, "utf8").trim().split("\n")) { cur += l === "+" ? 1 : -1; max = Math.max(max, cur); }
	assert.equal(max, 2);
	assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 10);
});

test("inspectVerifySlots: empty config / unlimited / empty lock dir", () => {
	const emptyEnv = resolveVerifyQueueConfig({});
	assert.equal(emptyEnv.limit, DEFAULT_VERIFY_CONCURRENCY);
	assert.equal(emptyEnv.maxWaitMs, DEFAULT_VERIFY_QUEUE_MAX_MS);

	const unlimited = inspectVerifySlots({ limit: 0, maxWaitMs: 0, lockDir: "/tmp/vq-none" });
	assert.equal(unlimited.inUse, 0);
	assert.deepEqual(unlimited.holders, []);

	const lockDir = dir();
	const empty = inspectVerifySlots({ limit: 2, maxWaitMs: 1_000, lockDir });
	assert.equal(empty.inUse, 0);
	assert.deepEqual(empty.holders, []);
	assert.equal(empty.config.lockDir, lockDir);
});

test("inspectVerifySlots: rate-limit full (live holders) then recovery after release", async () => {
	const lockDir = dir();
	const cfg = { limit: 1, maxWaitMs: 10_000, lockDir };
	const events: VerifyQueueEvent["phase"][] = [];
	setVerifyQueueListener((e) => events.push(e.phase));
	try {
		const held = await acquireVerifySlot("npm test", cfg);
		const full = inspectVerifySlots(cfg);
		assert.equal(full.inUse, 1);
		assert.equal(full.holders.length, 1);
		assert.equal(full.holders[0]?.pid, process.pid);
		assert.equal(full.holders[0]?.alive, true);
		assert.equal(full.holders[0]?.command, "npm test");

		// Second acquire is rate-limited until release (recover path).
		let secondGot = false;
		const secondP = acquireVerifySlot("tsc", cfg).then((s) => {
			secondGot = true;
			return s;
		});
		await new Promise((r) => setTimeout(r, 800));
		assert.equal(secondGot, false);
		assert.ok(events.includes("waiting") || events.includes("acquired"));

		held.release();
		const second = await secondP;
		assert.equal(second.overflow, false);
		assert.ok(secondGot);
		assert.ok(events.includes("released"));
		assert.ok(events.includes("acquired"));

		second.release();
		const recovered = inspectVerifySlots(cfg);
		assert.equal(recovered.inUse, 0);
		assert.deepEqual(recovered.holders, []);
		assert.deepEqual(fs.readdirSync(lockDir), []);
	} finally {
		setVerifyQueueListener(undefined);
	}
});

test("inspectVerifySlots: dead-pid holders report alive=false (doctor STALE path input)", () => {
	const lockDir = dir();
	const deadPid = 2 ** 22 + 99;
	fs.writeFileSync(
		path.join(lockDir, "slot-0.lock"),
		JSON.stringify({ pid: deadPid, host: os.hostname(), at: 1, command: "hung-verify" }),
	);
	const view = inspectVerifySlots({ limit: 2, maxWaitMs: 1_000, lockDir });
	assert.equal(view.inUse, 1);
	assert.equal(view.holders[0]?.pid, deadPid);
	assert.equal(view.holders[0]?.alive, false);
	assert.equal(view.holders[0]?.command, "hung-verify");
});

test("overflow (rate-limit cap) then note; listener emits overflow", async () => {
	const lockDir = dir();
	const phases: string[] = [];
	setVerifyQueueListener((e) => phases.push(e.phase));
	try {
		fs.writeFileSync(
			path.join(lockDir, "slot-0.lock"),
			JSON.stringify({ pid: process.pid, host: os.hostname(), at: 0, command: "holder" }),
		);
		const s = await acquireVerifySlot("late", { limit: 1, maxWaitMs: 600, lockDir });
		assert.equal(s.overflow, true);
		assert.ok(phases.includes("overflow"));
		assert.match(queueNote(s, 1), /cap reached — ran without a slot/);
		// Overflow does not create a new lock; original live holder remains.
		const view = inspectVerifySlots({ limit: 1, maxWaitMs: 600, lockDir });
		assert.equal(view.inUse, 1);
		assert.equal(view.holders[0]?.alive, true);
	} finally {
		setVerifyQueueListener(undefined);
	}
});
