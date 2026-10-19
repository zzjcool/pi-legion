import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProcStatus, readProcRss } from "../../src/supervisor/proc-memory.ts";

/** One `/proc/<pid>/status` payload carrying the rows the probe reads. */
function statusText(rows: { rssKb?: number; peakKb?: number; extra?: string }): string {
	const lines = [
		"Name:\tpi",
		"Umask:\t0022",
		"State:\tS (sleeping)",
		...(rows.rssKb !== undefined ? [`VmRSS:\t   ${rows.rssKb} kB`] : []),
		...(rows.peakKb !== undefined ? [`VmHWM:\t   ${rows.peakKb} kB`] : []),
		...(rows.extra ? [rows.extra] : []),
		"Threads:\t11",
	];
	return `${lines.join("\n")}\n`;
}

test("readProcRss never throws across a batch of stale pids (UI-refresh contract)", () => {
	// The probe runs on every widget refresh, so a dead pid is the NORMAL case,
	// not an error. Guard the whole batch path: mixed valid/invalid/stale input
	// must degrade to `undefined` without throwing, every time.
	const batch = [0, -1, 2_147_483_600, Number.NaN, Number.POSITIVE_INFINITY, process.pid];
	for (const pid of batch) {
		assert.doesNotThrow(() => readProcRss(pid), `pid ${pid} must not throw`);
	}
	// Repeated calls are equally safe (a refresh loop hits this constantly).
	assert.doesNotThrow(() => {
		for (let i = 0; i < 5; i += 1) readProcRss(2_147_483_600);
	});
});

test("parseProcStatus reads VmRSS and VmHWM in megabytes", () => {
	assert.deepEqual(parseProcStatus(statusText({ rssKb: 155_648, peakKb: 204_800 })), {
		rssMb: 152,
		peakMb: 200,
	});
});

test("parseProcStatus keeps rss when VmHWM is absent", () => {
	// Linux only guarantees VmRSS; a kernel built without high-water tracking
	// (or a fixture missing the row) must still yield the resident figure.
	assert.deepEqual(parseProcStatus(statusText({ rssKb: 4_096 })), { rssMb: 4 });
});

test("parseProcStatus returns undefined when VmRSS is missing", () => {
	// A process with no resident rows is not a 0 MB process: it is one whose
	// memory could not be read, and the caller renders that as unknown.
	assert.equal(parseProcStatus(statusText({ peakKb: 8_192 })), undefined);
	assert.equal(parseProcStatus(""), undefined);
	assert.equal(parseProcStatus("Name:\tpi\nState:\tR (running)\n"), undefined);
});

test("parseProcStatus ignores unrelated Vm* rows", () => {
	// VmPeak (virtual) and VmSize are not RSS; reading them would overstate
	// memory by an order of magnitude, so they must not match.
	assert.deepEqual(
		parseProcStatus(statusText({ rssKb: 1_024, extra: "VmPeak:\t 9999999 kB\nVmSize:\t 8888888 kB" })),
		{ rssMb: 1 },
	);
});

test("parseProcStatus tolerates a malformed size without throwing", () => {
	assert.equal(parseProcStatus("VmRSS:\t not-a-number kB\n"), undefined);
});

test("readProcRss reports this process on Linux and never throws elsewhere", () => {
	const rss = readProcRss(process.pid);
	if (process.platform !== "linux") {
		// D-platform rule: a non-Linux host degrades to "unknown", not an error.
		assert.equal(rss, undefined);
		return;
	}
	assert.ok(rss, "the current process must have a readable VmRSS");
	assert.ok(rss.rssMb > 0, `expected a positive rss, got ${rss.rssMb}`);
	assert.ok(rss.peakMb === undefined || rss.peakMb >= rss.rssMb, "peak is never below current");
});

test("readProcRss returns undefined for a pid that does not exist", () => {
	// The exit race, deterministically: an out-of-range pid has no
	// /proc/<pid>/status at all, exactly like a child that just exited. A pid
	// can vanish between an isAlive() check and this read (proc-tree.ts records
	// the same race), so the probe reports "unknown" and never throws.
	assert.equal(readProcRss(2_147_483_600), undefined);
});

test("readProcRss returns undefined for invalid pids without touching the filesystem", () => {
	for (const pid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(readProcRss(pid), undefined, `pid ${pid} must yield undefined`);
	}
});
