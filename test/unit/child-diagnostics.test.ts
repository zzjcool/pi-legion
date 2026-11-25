/**
 * #468 — the child diagnostic sink.
 *
 * The bug these pin is a CHANNEL bug, not a severity one: an in-process child
 * shares the host's process, so its `console.warn` was drawn directly above the
 * user's input box (`[pi-legion] in-process child u2-automation turn_end hook
 * skipped: …`). #415 had already established that line is benign; it still
 * showed up. So the contract this file pins is:
 *
 *   - disk, always: `<runDir>/diagnostics.log`, timestamp + event + reason
 *   - host, never by default (neither console nor a UI notify)
 *   - host, per record, only behind `PI_LEGION_CHILD_DIAGNOSTICS=1`
 *   - host, ONCE, at run end, for real extension failures — never per event
 *
 * Mutation that must turn the first test red: `record()` calling `console.warn`
 * unconditionally instead of `if (this.hostEcho)`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	CHILD_DIAGNOSTICS_ENV,
	CHILD_DIAGNOSTICS_FILE,
	childDiagnosticsEnabled,
	childDiagnosticsLogFile,
	createChildDiagnosticSink,
	flushOnFailure,
} from "../../src/supervisor/child-diagnostics.ts";

/** A throwaway run dir plus a captured host channel. */
function runDirFixture() {
	const dir = mkdtempSync(path.join(tmpdir(), "legion-child-diag-"));
	const host: string[] = [];
	const logFile = path.join(dir, CHILD_DIAGNOSTICS_FILE);
	const read = () => {
		try {
			return readFileSync(logFile, "utf8");
		} catch {
			return "";
		}
	};
	return { dir, logFile, host, read, hostWrite: (line: string) => host.push(line) };
}

/** Run `fn` with the host-echo switch forced to `value` (restored afterwards). */
async function withSwitch<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
	const previous = process.env[CHILD_DIAGNOSTICS_ENV];
	if (value === undefined) delete process.env[CHILD_DIAGNOSTICS_ENV];
	else process.env[CHILD_DIAGNOSTICS_ENV] = value;
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env[CHILD_DIAGNOSTICS_ENV];
		else process.env[CHILD_DIAGNOSTICS_ENV] = previous;
	}
}

const SKIPPED = {
	event: "turn_end.skipped" as const,
	reason:
		"turn_end could not resolve the persisted assistant entry ID " +
		"(this turn's assistant message has no persisted entry, so the host ran no turn_end handler)",
};

test("#468: a benign diagnostic goes to the run log and NOWHERE near the host", async () => {
	const fixture = runDirFixture();
	await withSwitch(undefined, () => {
		const sink = createChildDiagnosticSink({
			child: "u2-automation",
			logFile: fixture.logFile,
			hostWrite: fixture.hostWrite,
		});
		sink.record(SKIPPED);
		assert.equal(sink.flush(), undefined, "nothing real happened, so the run owes the host nothing");
	});

	assert.deepEqual(fixture.host, [], "zero host output — this is the bug's whole point");
	const lines = fixture.read().trim().split("\n");
	assert.equal(lines.length, 1, "one record on disk; a benign skip is still not silence");
	assert.match(lines[0]!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /, "timestamped");
	assert.match(lines[0]!, /child=u2-automation /);
	assert.match(lines[0]!, /event=turn_end\.skipped /);
	assert.match(lines[0]!, /real=false /, "benign: never to be surfaced to the user");
	assert.match(lines[0]!, /reason=turn_end could not resolve the persisted assistant entry ID/);
});

test("#468: PI_LEGION_CHILD_DIAGNOSTICS=1 puts the records back on the host (control group)", async () => {
	const fixture = runDirFixture();
	await withSwitch("1", () => {
		const sink = createChildDiagnosticSink({ child: "u2-automation", logFile: fixture.logFile, hostWrite: fixture.hostWrite });
		sink.record(SKIPPED);
		sink.record({ event: "extension.error", reason: "builtin:mcp session_start: spawn npx ENOENT", real: true });
	});

	assert.equal(fixture.host.length, 2, "with the switch on, each record is echoed live");
	assert.match(fixture.host[0]!, /^\[pi-legion\] in-process child u2-automation turn_end hook skipped: /);
	assert.match(fixture.host[1]!, /^\[pi-legion\] in-process child u2-automation extension error: builtin:mcp/);
	// The switch changes WHERE it goes, not whether it is recorded.
	assert.equal(fixture.read().trim().split("\n").length, 2, "still one line per event on disk");
});

test("#468: the switch is off unless it is explicitly turned on", () => {
	const on = ["1", "true", "TRUE", "on", "yes", " 1 "];
	const off = [undefined, "", "0", "false", "off", "no", "none", "2", "enabled", "y"];
	for (const value of on) assert.equal(childDiagnosticsEnabled(value === undefined ? {} : { [CHILD_DIAGNOSTICS_ENV]: value }), true, `on: ${value}`);
	for (const value of off) assert.equal(childDiagnosticsEnabled(value === undefined ? {} : { [CHILD_DIAGNOSTICS_ENV]: value }), false, `off: ${value}`);
});

test("#468: a REAL extension failure reaches the host exactly ONCE, at run end", async () => {
	const fixture = runDirFixture();
	let sink!: ReturnType<typeof createChildDiagnosticSink>;
	await withSwitch(undefined, () => {
		sink = createChildDiagnosticSink({ child: "u2-automation", logFile: fixture.logFile, hostWrite: fixture.hostWrite });
		// Three failures in one run — the point is that the host sees ONE line, not three.
		sink.record({ event: "extension.error", reason: "builtin:mcp session_start: spawn npx ENOENT", real: true });
		sink.record({ event: "session_shutdown.failed", reason: "Error: close() timed out", real: true });
		sink.record({ event: "extension.registration.error", reason: "model provider 'x' did not register", real: true });
		assert.deepEqual(fixture.host, [], "nothing per event — no interleaved host spam");
	});

	const summary = sink.flush();
	assert.equal(typeof summary, "string", "the user must still learn that extensions failed");
	assert.equal(fixture.host.length, 1, "exactly one line for the whole run");
	assert.equal(summary!.includes("\n"), false, "one LINE, not a block");
	assert.match(summary!, /^\[pi-legion\] in-process child u2-automation: 3 extension errors this run — first: extension error: builtin:mcp/);
	assert.match(summary!, /\+\d+ more/, "the rest is counted, not dumped");
	assert.match(summary!, /details: /, "and the reader is pointed at the log file");
	assert.equal(fixture.host[0], summary, "the returned text is what the host got");

	// Idempotent: two dispose paths must not double-report.
	assert.equal(sink.flush(), undefined, "second flush is silent");
	assert.equal(fixture.host.length, 1, "still one line");

	// The disk record keeps ALL of it — visibility is compressed, information is not.
	const lines = fixture.read().trim().split("\n");
	assert.equal(lines.length, 3);
	assert.match(lines[1]!, /event=session_shutdown\.failed real=true reason=Error: close\(\) timed out/);
	assert.match(lines[2]!, /event=extension\.registration\.error real=true/);
});

test("#468: a single real failure still says one line (no plural, no dump)", async () => {
	const fixture = runDirFixture();
	const sink = createChildDiagnosticSink({ logFile: fixture.logFile, hostWrite: fixture.hostWrite });
	sink.record({ event: "dispose.failed", reason: "Error: boom", real: true });
	const summary = sink.flush();
	assert.match(summary!, /^\[pi-legion\] in-process child: 1 extension error this run — first: dispose failed: Error: boom/);
	assert.equal(fixture.host.length, 1);
});

test("#468: multi-line causes are flattened (a host record is one line by contract)", async () => {
	const fixture = runDirFixture();
	const sink = createChildDiagnosticSink({ child: "c", logFile: fixture.logFile, hostWrite: fixture.hostWrite });
	sink.record({ event: "extension.error", reason: "first line\n  at somewhere\n  at elsewhere", real: true });
	const [record] = fixture.read().trim().split("\n");
	assert.equal(record!.includes("\n"), false);
	assert.match(record!, /reason=first line at somewhere at elsewhere$/);
});

test("#468: no log file ⇒ memory only, and still no host output", () => {
	const host: string[] = [];
	const sink = createChildDiagnosticSink({ child: "c", hostWrite: (line) => host.push(line) });
	sink.record(SKIPPED);
	sink.record({ event: "extension.error", reason: "boom", real: true });
	assert.equal(sink.records.length, 2, "the run's records are still readable in-process");
	assert.deepEqual(host, [], "the benign record never reaches the host");
	// The real failure still does — once, and with no file to point at.
	const summary = sink.flush();
	assert.match(summary!, /^\[pi-legion\] in-process child c: 1 extension error this run/);
	assert.doesNotMatch(summary!, /details:/, "nothing to point at when no log file is set");
	assert.deepEqual(host, [summary]);
});

test("#468: an unwritable run dir never throws out of a diagnostic", () => {
	// The sink runs on the `dispose()` path: a failed write must not become a failed retire.
	const dir = mkdtempSync(path.join(tmpdir(), "legion-child-diag-"));
	const blocker = path.join(dir, "not-a-dir");
	writeFileSync(blocker, "");
	const sink = createChildDiagnosticSink({ child: "c", logFile: path.join(blocker, CHILD_DIAGNOSTICS_FILE), hostWrite: () => {} });
	assert.doesNotThrow(() => sink.record(SKIPPED));
	assert.doesNotThrow(() => sink.record({ event: "extension.error", reason: "boom", real: true }));
	assert.equal(sink.records.length, 2, "the in-memory copy survives the failed write");

	// A throwing host writer is the same rule.
	const throwing = createChildDiagnosticSink({ host: true, hostWrite: () => { throw new Error("host gone"); } });
	assert.doesNotThrow(() => throwing.record(SKIPPED));
	assert.doesNotThrow(() => throwing.flush());
});

test("#468: <runDir> is the transcript's directory — both transports land in it", () => {
	// In-process child: the orchestrator pre-creates `<runDir>/<name>.jsonl`.
	assert.equal(childDiagnosticsLogFile("/runs/r-42/u2-automation.jsonl"), path.join("/runs/r-42", CHILD_DIAGNOSTICS_FILE));
	// No transcript file (in-memory manager) ⇒ no invented location.
	assert.equal(childDiagnosticsLogFile(undefined), undefined);
	assert.equal(childDiagnosticsLogFile(""), undefined);
	assert.equal(childDiagnosticsLogFile("   "), undefined);
	// A bare filename has no run directory to write into.
	assert.equal(childDiagnosticsLogFile("child.jsonl"), undefined);
});

test("#468: a spawn that dies before the session exists still owes the host its one line", async () => {
	// The factory records extension-registration failures BEFORE it has a session, so
	// there is no armed `dispose()` to flush them. `flushOnFailure` is what keeps
	// "the spawn died" from meaning "the failure went silent" (review finding #1).
	const fixture = runDirFixture();
	const sink = createChildDiagnosticSink({ child: "u2-automation", logFile: fixture.logFile, hostWrite: fixture.hostWrite });
	sink.record({ event: "extension.registration.error", reason: "provider 'x' did not register", real: true });

	// The step succeeds → the run is still going, so the host hears nothing yet.
	assert.equal(await flushOnFailure(sink, () => "ok"), "ok");
	assert.deepEqual(fixture.host, [], "no line while the run is alive");

	const next = createChildDiagnosticSink({ child: "u2-automation", logFile: fixture.logFile, hostWrite: fixture.hostWrite });
	next.record({ event: "extension.registration.error", reason: "provider 'x' did not register", real: true });
	await assert.rejects(
		() => flushOnFailure(next, () => { throw new Error("createAgentSession exploded"); }),
		/createAgentSession exploded/,
		"the original failure propagates untouched",
	);
	assert.equal(fixture.host.length, 1, "and the owed line is written exactly once before it does");
	assert.match(fixture.host[0]!, /in-process child u2-automation: 1 extension error this run — first: extension registration error: provider 'x' did not register/);

	// A second flush (e.g. a later dispose) must not double-report.
	next.flush();
	assert.equal(fixture.host.length, 1);
});
